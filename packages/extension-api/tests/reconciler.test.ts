/**
 * Contract tests for the guest reconciler.
 *
 * These exist because the reconciler failures found during the spike were all
 * SILENT: a wrong `commitUpdate` arity produced a tree that looked fine on the
 * first commit and then stopped updating, with the underlying throw swallowed
 * by an optional call. Every assertion here is a regression guard for a real
 * bug that cost debugging time.
 *
 * The bridge is stubbed so this runs in plain Node — the reconciler logic is
 * independent of QuickJS, and testing it here is far faster than round-tripping
 * through a VM.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { createElement, useEffect, useState } from "react";
import type { HostTree } from "../src/protocol";

// --- stub the guest bridge before importing the reconciler ----------------

const commits: HostTree[] = [];
const logs: { level: string; message: string }[] = [];

vi.mock("../src/runtime/bridge", () => {
  // Route the bridge's timers through the same global queue React's scheduler
  // uses. That is what `installTimerGlobals` does in the VM, and keeping one
  // queue here is what makes `runTimers` a faithful pump: two queues would let
  // scheduler work sit unflushed and hide effect-driven update bugs.
  const g = globalThis as unknown as {
    __vmTimers: { run(): void; pending(): number; reset(): void };
    setTimeout: (fn: () => void, delay: number) => number;
    clearTimeout: (id: number) => void;
  };
  const vm = g.__vmTimers;
  const vmSetTimeout = g.setTimeout;
  const vmClearTimeout = g.clearTimeout;
  const bridge = {
    commit: (tree: HostTree) => {
      // Force the same JSON round-trip the real boundary performs, so a
      // non-serializable tree fails here exactly as it would in production.
      commits.push(JSON.parse(JSON.stringify(tree)));
    },
    log: (level: string, message: string) => logs.push({ level, message }),
    toast: () => {},
    invoke: () => Promise.resolve(null),
    setTimeout: (fn: () => void, delay: number) => vmSetTimeout(fn, delay),
    clearTimeout: (id: number) => vmClearTimeout(id),
    runTimers: () => vm.run(),
    hasPendingWork: () => vm.pending() > 0,
  };
  return {
    bridge,
    resolveCapability: () => {},
    CapabilityError: Error,
    installTimerGlobals: () => {},
  };
});

const { mount, unmount, invokeHandler, flushWork } = await import("../src/runtime/reconciler");

function reset() {
  commits.length = 0;
  logs.length = 0;
  (globalThis as unknown as { __vmTimers: { reset(): void } }).__vmTimers.reset();
  unmount();
  flushWork();
  commits.length = 0;
}

const latest = () => commits[commits.length - 1];

describe("guest reconciler", () => {
  beforeEach(reset);

  it("serializes a tree the host can render", () => {
    mount(
      createElement(
        "List",
        { isLoading: false },
        createElement("List.Item", { key: "a", title: "Alpha", subtitle: "first" }),
        createElement("List.Item", { key: "b", title: "Beta" }),
      ),
    );

    const tree = latest();
    expect(tree.root).toHaveLength(1);
    expect(tree.root[0].type).toBe("List");
    expect(tree.root[0].props.isLoading).toBe(false);
    expect(tree.root[0].children.map((c) => c.props.title)).toEqual(["Alpha", "Beta"]);
  });

  // The regression guard for hazard #2 from the spike. A wrong commitUpdate
  // arity puts React's fiber into props, which cycles via props.stateNode.
  // Note commits are deliberately coalesced, so the guard is that the tree
  // *updated* (only reachable by driving commitUpdate three times) and stayed
  // serializable - not that a particular number of frames crossed.
  it("produces JSON-serializable trees across updates", () => {
    function Counter() {
      const [n, setN] = useState(0);
      useEffect(() => {
        if (n < 3) setN(n + 1);
      }, [n]);
      return createElement(
        "List",
        { searchText: String(n) },
        createElement("List.Item", { title: `n=${n}` }),
      );
    }

    mount(createElement(Counter));
    for (let i = 0; i < 5; i++) flushWork();

    expect(commits.length).toBeGreaterThan(0);
    for (const tree of commits) expect(() => JSON.stringify(tree)).not.toThrow();
    expect(latest().root[0].props.searchText).toBe("3");
    expect(latest().root[0].children[0].props.title).toBe("n=3");
  });

  it("re-renders on state change driven by an event", () => {
    function Toggle() {
      const [on, setOn] = useState(false);
      return createElement("List", {
        searchText: on ? "on" : "off",
        onSearchTextChange: () => setOn(true),
      });
    }

    mount(createElement(Toggle));
    expect(latest().root[0].props.searchText).toBe("off");

    const handlerId = latest().root[0].handlers.onSearchTextChange;
    expect(handlerId).toBeTruthy();

    invokeHandler(handlerId, ["typed"]);
    flushWork();
    expect(latest().root[0].props.searchText).toBe("on");
  });

  it("keeps handler ids stable across re-renders so in-flight events survive", () => {
    function Stable() {
      const [n, setN] = useState(0);
      return createElement("List", {
        searchText: String(n),
        onSearchTextChange: () => setN(n + 1),
      });
    }

    mount(createElement(Stable));
    const first = latest().root[0].handlers.onSearchTextChange;

    invokeHandler(first, []);
    flushWork();

    expect(latest().root[0].props.searchText).toBe("1");
    expect(latest().root[0].handlers.onSearchTextChange).toBe(first);
  });

  it("drops functions, class instances and cycles from props", () => {
    class Exotic {
      danger = "should not cross";
    }
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;

    mount(
      createElement("List.Item", {
        title: "ok",
        instance: new Exotic(),
        cyclic,
        nested: { fine: true, deep: [1, 2, { x: "y" }] },
        onAction: () => {},
      }),
    );

    const node = latest().root[0];
    expect(node.props.title).toBe("ok");
    expect(node.props.instance).toBeUndefined();
    expect(node.props.cyclic).toBeUndefined();
    expect(node.props.nested).toEqual({ fine: true, deep: [1, 2, { x: "y" }] });
    // Functions become handler ids, never props.
    expect(node.props.onAction).toBeUndefined();
    expect(node.handlers.onAction).toMatch(/^h\d+$/);
  });

  it("coalesces multiple commits within one turn", () => {
    mount(createElement("List", {}, createElement("List.Item", { title: "x" })));
    const afterMount = commits.length;
    flushWork();
    flushWork();
    // No state changed, so no additional frames should be produced.
    expect(commits.length).toBe(afterMount);
  });

  it("removes children and releases their handlers", () => {
    function Toggler() {
      const [show, setShow] = useState(true);
      return createElement(
        "List",
        { onSearchTextChange: () => setShow(false) },
        show ? createElement("List.Item", { title: "gone soon", onAction: () => {} }) : null,
      );
    }

    mount(createElement(Toggler));
    expect(latest().root[0].children).toHaveLength(1);
    const childHandler = latest().root[0].children[0].handlers.onAction;

    invokeHandler(latest().root[0].handlers.onSearchTextChange, []);
    flushWork();

    expect(latest().root[0].children).toHaveLength(0);
    // The stale handler must be gone, not silently retained.
    invokeHandler(childHandler, []);
    expect(logs.some((l) => l.message.includes("unknown handler"))).toBe(true);
  });

  it("renders text children as #text nodes", () => {
    mount(createElement("Detail.Metadata.Label", { title: "Words" }, "hello"));
    const node = latest().root[0];
    expect(node.children[0].type).toBe("#text");
    expect(node.children[0].props.text).toBe("hello");
  });

  it("increments revision so the host can drop stale frames", () => {
    function Bump() {
      const [n, setN] = useState(0);
      return createElement("List", {
        searchText: String(n),
        onSearchTextChange: () => setN(n + 1),
      });
    }
    mount(createElement(Bump));
    const first = latest().revision;
    invokeHandler(latest().root[0].handlers.onSearchTextChange, []);
    flushWork();
    expect(latest().revision).toBeGreaterThan(first);
  });
});
