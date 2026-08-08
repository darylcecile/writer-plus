/**
 * Guest-side React reconciler. Runs INSIDE the QuickJS VM.
 *
 * It never produces DOM. It maintains a plain-object tree and serializes it
 * to JSON on every commit; the host renders that with its own components.
 *
 * Three constraints are load-bearing and were each found the hard way in the
 * spike (see SPECs/extensions-system-spec.md "Hazards"):
 *
 *   1. `commitUpdate` in react-reconciler 0.33 is
 *      `(instance, type, oldProps, newProps, fiber)`. The older form with a
 *      `payload` slot puts React's internal fiber where `newProps` belongs,
 *      which serializes a cycle at `props.stateNode` and silently breaks
 *      every commit after the first. `react-reconciler` is pinned and
 *      `tests/reconciler.test.ts` asserts committed trees are
 *      JSON-serializable so a bump cannot regress this quietly.
 *
 *   2. Props are ALLOWLISTED, never copied wholesale. Only primitives, plain
 *      objects, arrays and functions cross. Functions become opaque ids.
 *
 *   3. There is no ambient event loop in the VM. Timers are host-provided and
 *      drained explicitly. React's scheduler falls back to `setTimeout` when
 *      `MessageChannel`/`setImmediate` are absent, which is why this works.
 */

import ReactReconciler from "react-reconciler";
import { DiscreteEventPriority } from "react-reconciler/constants.js";
import type { ReactNode } from "react";
import type { HostNode, JsonValue } from "../protocol";
import { bridge } from "./bridge";

interface Instance {
  id: number;
  type: string;
  props: Record<string, JsonValue>;
  handlers: Record<string, string>;
  children: (Instance | TextInstance)[];
  parent: Instance | Container | null;
}

interface TextInstance {
  id: number;
  text: string;
  isText: true;
  parent: Instance | Container | null;
}

interface Container {
  children: (Instance | TextInstance)[];
  isContainer: true;
}

let nextInstanceId = 1;
let nextHandlerId = 1;

/** callback id -> live function. */
const handlerRegistry = new Map<string, (...args: unknown[]) => unknown>();

export function invokeHandler(id: string, args: unknown[]): void {
  const fn = handlerRegistry.get(id);
  if (!fn) {
    // Normal during rapid re-renders: the host may still hold a stale frame.
    bridge.log("debug", `event for unknown handler ${id} (stale frame)`);
    return;
  }
  fn(...args);
}

function isTextInstance(n: Instance | TextInstance): n is TextInstance {
  return (n as TextInstance).isText === true;
}

/**
 * Thrown when a prop cannot cross the boundary. Caught in `splitProps`, which
 * drops the whole prop. Rejecting wholesale matters: truncating a cyclic
 * object at a depth limit would hand the host a plausible-looking 12-deep copy
 * of a structure that never existed, which is worse than a missing prop.
 */
const REJECT = Symbol("writer.prop.reject");

/**
 * Allowlist a prop value. Returns `undefined` for values that are simply
 * absent (undefined/function/symbol); throws REJECT for values that are
 * actively unsafe (cyclic, or nested past the depth bound).
 *
 * `seen` holds the objects on the current path, not every object visited, so
 * a DAG that repeats a shared child is still allowed - only a true back-edge
 * is a cycle.
 */
function sanitize(value: unknown, depth = 0, seen: Set<object> = new Set()): JsonValue | undefined {
  if (depth > 12) throw REJECT;
  if (value === null) return null;

  const t = typeof value;
  if (t === "string" || t === "boolean") return value as JsonValue;
  if (t === "number") return Number.isFinite(value as number) ? (value as number) : null;
  if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") return undefined;

  const obj = value as object;
  if (seen.has(obj)) throw REJECT;
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const out: JsonValue[] = [];
      for (const item of value) {
        const s = sanitize(item, depth + 1, seen);
        out.push(s === undefined ? null : s);
      }
      return out;
    }

    if (t === "object") {
      // Plain objects only. Anything with a custom prototype (class instances,
      // React fibers, Errors) is rejected outright.
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) return undefined;
      const out: Record<string, JsonValue> = {};
      for (const key of Object.keys(obj)) {
        const s = sanitize((value as Record<string, unknown>)[key], depth + 1, seen);
        if (s !== undefined) out[key] = s;
      }
      return out;
    }
    return undefined;
  } finally {
    seen.delete(obj);
  }
}

function splitProps(
  props: Record<string, unknown>,
  previousHandlers?: Record<string, string>,
): { props: Record<string, JsonValue>; handlers: Record<string, string> } {
  const data: Record<string, JsonValue> = {};
  const handlers: Record<string, string> = {};

  for (const key of Object.keys(props)) {
    if (key === "children" || key === "key" || key === "ref") continue;
    const value = props[key];

    if (typeof value === "function") {
      // Reuse the id across re-renders so in-flight events and the host's
      // event routing survive a parent re-render.
      const id = previousHandlers?.[key] ?? `h${nextHandlerId++}`;
      handlerRegistry.set(id, value as (...a: unknown[]) => unknown);
      handlers[key] = id;
      continue;
    }

    try {
      const s = sanitize(value);
      if (s !== undefined) data[key] = s;
    } catch (error) {
      if (error !== REJECT) throw error;
      // Dropped, not silently mangled - the extension author gets told.
      bridge.log("warn", `prop "${key}" dropped: value is cyclic or nested too deeply`);
    }
  }
  return { props: data, handlers };
}

function releaseHandlers(node: Instance | TextInstance): void {
  if (isTextInstance(node)) return;
  for (const id of Object.values(node.handlers)) handlerRegistry.delete(id);
  for (const child of node.children) releaseHandlers(child);
}

function serializeNode(node: Instance | TextInstance): HostNode {
  if (isTextInstance(node)) {
    return { id: node.id, type: "#text", props: { text: node.text }, handlers: {}, children: [] };
  }
  return {
    id: node.id,
    type: node.type,
    props: node.props,
    handlers: node.handlers,
    children: node.children.map(serializeNode),
  };
}

// --------------------------------------------------------------- host config

const NO_CONTEXT = {};
// All updates run on the sync lane (DiscreteEventPriority), never the
// concurrent lane. This is load-bearing for two reasons:
//
//  1. Concurrent-lane work is drained by React's `scheduler`, which reaches for
//     `MessageChannel` and falls back to `setTimeout`. QuickJS has neither
//     ambiently, so concurrent updates would simply never render.
//  2. Node *does* have `MessageChannel`, so a concurrent-lane renderer would
//     behave differently under test than in the VM. Pinning to sync keeps the
//     test environment an honest model of production.
//
// The cost is no time-slicing, which an extension panel does not need.
let currentUpdatePriority: number = DiscreteEventPriority;
const container: Container = { children: [], isContainer: true };

function detach(parent: Instance | Container, child: Instance | TextInstance): void {
  const i = parent.children.indexOf(child);
  if (i !== -1) parent.children.splice(i, 1);
}

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  scheduleTimeout: (fn: () => void, delay?: number) => bridge.setTimeout(fn, delay ?? 0),
  cancelTimeout: (id: number) => bridge.clearTimeout(id),

  createInstance(type: string, props: Record<string, unknown>): Instance {
    const { props: data, handlers } = splitProps(props);
    return { id: nextInstanceId++, type, props: data, handlers, children: [], parent: null };
  },

  createTextInstance(text: string): TextInstance {
    return { id: nextInstanceId++, text, isText: true, parent: null };
  },

  appendInitialChild(parent: Instance, child: Instance | TextInstance) {
    child.parent = parent;
    parent.children.push(child);
  },

  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getRootHostContext: () => NO_CONTEXT,
  getChildHostContext: (parent: unknown) => parent,
  getPublicInstance: (instance: Instance) => instance,
  prepareForCommit: () => null,
  preparePortalMount: () => {},
  resetAfterCommit: () => scheduleCommit(),

  appendChild(parent: Instance, child: Instance | TextInstance) {
    detach(parent, child);
    child.parent = parent;
    parent.children.push(child);
  },
  appendChildToContainer(c: Container, child: Instance | TextInstance) {
    detach(c, child);
    child.parent = c;
    c.children.push(child);
  },
  insertBefore(parent: Instance, child: Instance | TextInstance, before: Instance | TextInstance) {
    detach(parent, child);
    const at = parent.children.indexOf(before);
    child.parent = parent;
    parent.children.splice(at === -1 ? parent.children.length : at, 0, child);
  },
  insertInContainerBefore(
    c: Container,
    child: Instance | TextInstance,
    before: Instance | TextInstance,
  ) {
    detach(c, child);
    const at = c.children.indexOf(before);
    child.parent = c;
    c.children.splice(at === -1 ? c.children.length : at, 0, child);
  },
  removeChild(parent: Instance, child: Instance | TextInstance) {
    detach(parent, child);
    releaseHandlers(child);
  },
  removeChildFromContainer(c: Container, child: Instance | TextInstance) {
    detach(c, child);
    releaseHandlers(child);
  },
  clearContainer(c: Container) {
    // Deliberately does NOT release handlers. React calls this during an
    // ordinary commit and then re-appends the same instances, so releasing
    // here would orphan live callbacks. Deletion owns release, via
    // removeChild* and detachDeletedInstance.
    c.children.length = 0;
  },

  // SIGNATURE IS LOAD-BEARING — see the note at the top of this file.
  commitUpdate(
    instance: Instance,
    _type: string,
    _oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
  ) {
    const { props: data, handlers } = splitProps(newProps, instance.handlers);
    // Drop handler ids that no longer exist so the registry can't grow unbounded.
    for (const [key, id] of Object.entries(instance.handlers)) {
      if (handlers[key] !== id) handlerRegistry.delete(id);
    }
    instance.props = data;
    instance.handlers = handlers;
  },

  commitTextUpdate(textInstance: TextInstance, _old: string, newText: string) {
    textInstance.text = newText;
  },

  detachDeletedInstance: (node: Instance | TextInstance) => releaseHandlers(node),

  getCurrentUpdatePriority: () => currentUpdatePriority,
  setCurrentUpdatePriority: (p: number) => {
    currentUpdatePriority = p;
  },
  resolveUpdatePriority: () => currentUpdatePriority || DiscreteEventPriority,

  getInstanceFromNode: () => null,
  getInstanceFromScope: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  shouldAttemptEagerTransition: () => false,
  requestPostPaintCallback: () => {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  NotPendingTransition: null,
  HostTransitionContext: {
    $$typeof: Symbol.for("react.context"),
    Provider: null,
    Consumer: null,
    _currentValue: null,
    _currentValue2: null,
    _threadCount: 0,
  },
};

// react-reconciler's published types lag its runtime signatures (the
// commitUpdate arity above is the concrete example), so the config is passed
// through `unknown`. The behaviour is pinned by tests/reconciler.test.ts
// rather than by these types.
const reconciler = (ReactReconciler as unknown as (c: unknown) => ReconcilerInstance)(hostConfig);

interface ReconcilerInstance {
  createContainer(...args: unknown[]): unknown;
  updateContainer(element: ReactNode, root: unknown, parent: unknown, cb: unknown): void;
  flushSyncWork?(): void;
  flushPassiveEffects?(): boolean;
}

// ------------------------------------------------------------------ commits

let revision = 0;
let commitScheduled = false;

/**
 * Coalesce commits within a turn. React calls `resetAfterCommit` several
 * times per interaction (sync pass, then passive effects); sending each
 * separately would multiply boundary crossings for no benefit.
 */
function scheduleCommit(): void {
  if (commitScheduled) return;
  commitScheduled = true;
  bridge.setTimeout(() => {
    commitScheduled = false;
    bridge.commit({ revision: ++revision, root: container.children.map(serializeNode) });
  }, 0);
}

let root: unknown = null;

export function mount(element: ReactNode): void {
  root ??= reconciler.createContainer(
    container,
    1, // ConcurrentRoot
    null,
    false,
    null,
    "writer",
    (error: unknown) => bridge.log("error", `recoverable: ${String(error)}`),
    (error: unknown) => bridge.log("error", `caught: ${String(error)}`),
    (error: unknown) => bridge.log("error", `uncaught: ${String(error)}`),
    null,
  );
  reconciler.updateContainer(element, root, null, null);
  flushWork();
}

/**
 * Drive React forward until it settles. The VM has no ambient loop, so every
 * turn of the crank is ours: a passive effect can call setState, which the
 * scheduler enqueues as a timer, which renders, which runs another effect.
 *
 * Bounded so a component that setStates in an unconditional effect degrades to
 * a logged warning instead of hanging the VM until the interrupt handler fires.
 */
export function flushWork(): void {
  for (let pass = 0; pass < 50; pass++) {
    reconciler.flushSyncWork?.();
    bridge.runTimers();
    const didWork = reconciler.flushPassiveEffects?.() ?? false;
    bridge.runTimers();
    if (!didWork && !bridge.hasPendingWork()) return;
  }
  bridge.log("warn", "render did not settle in 50 passes; check for a setState loop in an effect");
}

export function unmount(): void {
  if (root) reconciler.updateContainer(null, root, null, null);
  handlerRegistry.clear();
  container.children.length = 0;
}
