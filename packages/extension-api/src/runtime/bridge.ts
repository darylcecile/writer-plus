/**
 * The guest's ONLY route out of the VM.
 *
 * `__writer` is injected by the host as a small set of function handles.
 * Everything an extension can observe about the outside world goes through
 * here, which is what makes the capability gate meaningful: there is no
 * `fetch`, no `require`, no `window`, no Tauri IPC inside the VM, so an
 * extension cannot route around this file.
 *
 * The VM also has no event loop. `setTimeout` is emulated with a host clock
 * and a local queue drained by `runTimers()`, which the host calls after
 * every interaction. React's scheduler falls back to `setTimeout` when
 * `MessageChannel` and `setImmediate` are absent, so this is enough to make
 * concurrent React work.
 */

import type { CapabilityResult, HostTree, JsonValue } from "../protocol";

interface WriterGlobal {
  commit(json: string): void;
  log(level: string, message: string): void;
  capability(callId: number, json: string): void;
  toast(json: string): void;
  now(): number;
}

declare const __writer: WriterGlobal;

// ------------------------------------------------------------------ timers

interface Timer {
  id: number;
  due: number;
  fn: () => void;
}

let nextTimerId = 1;
let timers: Timer[] = [];

// ------------------------------------------------------------ capabilities

let nextCallId = 1;
const pending = new Map<number, (result: CapabilityResult) => void>();

/** Called by the host when a capability request settles. */
export function resolveCapability(callId: number, result: CapabilityResult): void {
  const resolve = pending.get(callId);
  if (!resolve) return;
  pending.delete(callId);
  resolve(result);
}

export const bridge = {
  commit(tree: HostTree): void {
    // MUST stringify here. `ctx.dump()` on the host does not deep-serialize
    // object graphs — a plain object comes back as the literal string
    // "[object Object]". Verified in the spike.
    __writer.commit(JSON.stringify(tree));
  },

  log(level: "debug" | "info" | "warn" | "error", message: string): void {
    __writer.log(level, message);
  },

  toast(style: "success" | "failure" | "animated", title: string, message?: string): void {
    __writer.toast(JSON.stringify({ style, title, message }));
  },

  /**
   * Issue a capability request. Resolves with the host's answer; rejects only
   * on a denied/failed result so extension code can use ordinary try/catch.
   */
  invoke<T = JsonValue>(capability: string, method: string, args: JsonValue[]): Promise<T> {
    const callId = nextCallId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(callId, (result) => {
        if (result.ok) resolve(result.value as T);
        else reject(new CapabilityError(result.code, result.message, capability, method));
      });
      __writer.capability(callId, JSON.stringify({ capability, method, args }));
    });
  },

  setTimeout(fn: () => void, delay: number): number {
    const id = nextTimerId++;
    timers.push({ id, due: __writer.now() + Math.max(0, delay), fn });
    return id;
  },

  clearTimeout(id: number): void {
    timers = timers.filter((t) => t.id !== id);
  },

  /**
   * Run every timer that is due. Loops because a timer may schedule another
   * zero-delay timer (React's scheduler does exactly this); bounded so a
   * misbehaving extension can't spin here forever — the runtime interrupt
   * handler is the outer backstop.
   */
  runTimers(): void {
    for (let pass = 0; pass < 1000; pass++) {
      const now = __writer.now();
      const due = timers.filter((t) => t.due <= now);
      if (due.length === 0) return;
      timers = timers.filter((t) => t.due > now);
      for (const t of due) {
        try {
          t.fn();
        } catch (e) {
          bridge.log("error", `timer threw: ${String(e)}`);
        }
      }
    }
    bridge.log("warn", "timer queue did not drain in 1000 passes");
  },

  hasPendingWork(): boolean {
    return timers.length > 0 || pending.size > 0;
  },
};

/**
 * Publish the emulated timers as VM globals.
 *
 * React's scheduler captures its host callback at *module init* time, picking
 * the first of `setImmediate`, `MessageChannel`, `setTimeout` that exists
 * (scheduler 0.27.0, cjs/scheduler.development.js ~L207-229). QuickJS provides
 * none of them, so without this the scheduler's `localSetTimeout` is null and
 * any effect-driven update throws instead of rendering.
 *
 * Must run before the extension bundle - and therefore React - is evaluated.
 * `setImmediate` and `MessageChannel` are deliberately left absent so the
 * scheduler falls through to our pumpable `setTimeout`, keeping every flush
 * driven by the host rather than by an ambient loop.
 */
export function installTimerGlobals(target: Record<string, unknown> = globalThis as never): void {
  target.setTimeout = (fn: () => void, delay = 0) => bridge.setTimeout(fn, delay);
  target.clearTimeout = (id: number) => bridge.clearTimeout(id);
  delete target.setImmediate;
  delete target.MessageChannel;
}

export class CapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly capability: string,
    readonly method: string,
  ) {
    super(`${capability}.${method}: ${message}`);
    this.name = "CapabilityError";
  }
}
