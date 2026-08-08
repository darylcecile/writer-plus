/**
 * Integration tests for the QuickJS VM wrapper.
 *
 * These deliberately run a real VM rather than a mock. Every bug this file
 * guards against - handle leaks aborting the WASM module, `dump()` refusing to
 * serialize object graphs, timers never firing because the scheduler had no
 * globals - is invisible to a mocked VM and only appears when real QuickJS
 * runs the code.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { ExtensionVm, type VmCallbacks } from "../src/vm";

let wasm: QuickJSWASMModule;

beforeAll(async () => {
  wasm = await newQuickJSWASMModuleFromVariant(releaseSync);
});

function harness(overrides: Partial<VmCallbacks> = {}) {
  const commits: unknown[] = [];
  const logs: { level: string; message: string }[] = [];
  const capabilities: { callId: number; request: unknown }[] = [];
  const toasts: unknown[] = [];

  const callbacks: VmCallbacks = {
    onCommit: (t) => commits.push(t),
    onLog: (level, message) => logs.push({ level, message }),
    onCapability: (callId, request) => capabilities.push({ callId, request }),
    onToast: (style, title, message) => toasts.push({ style, title, message }),
    ...overrides,
  };

  return { vm: new ExtensionVm(wasm, callbacks), commits, logs, capabilities, toasts };
}

describe("ExtensionVm", () => {
  it("starts with no ambient capabilities", () => {
    // The isolation claim, asserted rather than assumed. If any of these
    // becomes defined, an extension can reach the network or the host
    // without passing the permission gate.
    const probes = ["fetch", "XMLHttpRequest", "process", "require", "window", "WebAssembly"];
    for (const name of probes) {
      const captured: string[] = [];
      const vm = new ExtensionVm(wasm, {
        onCommit: () => {},
        onLog: (_l, m) => captured.push(m),
        onCapability: () => {},
        onToast: () => {},
      });
      try {
        vm.evaluate(`__writer.log("info", String(typeof ${name}))`);
        expect(captured[0], `${name} must not exist in the VM`).toBe("undefined");
      } finally {
        vm.dispose();
      }
    }
  });

  it("provides setTimeout but not the schedulers React would prefer", () => {
    const { vm, logs } = harness();
    try {
      vm.evaluate(`__writer.log("info", [
        typeof setTimeout,
        typeof clearTimeout,
        typeof setImmediate,
        typeof MessageChannel
      ].join(","))`);
      // setImmediate/MessageChannel must stay absent so React's scheduler
      // falls through to the setTimeout queue the host can actually drain.
      expect(logs[0].message).toBe("function,function,undefined,undefined");
    } finally {
      vm.dispose();
    }
  });

  it("runs timers only when the host pumps them", () => {
    const { vm, logs } = harness();
    try {
      vm.evaluate(`setTimeout(() => __writer.log("info", "fired"), 0)`);
      expect(logs).toHaveLength(0); // no ambient loop: nothing runs on its own
      vm.runTimers();
      expect(logs.map((l) => l.message)).toEqual(["fired"]);
    } finally {
      vm.dispose();
    }
  });

  it("runs chained and delayed timers, advancing the virtual clock", () => {
    const { vm, logs } = harness();
    try {
      vm.evaluate(`
        setTimeout(() => {
          __writer.log("info", "a");
          setTimeout(() => __writer.log("info", "b"), 50);
        }, 0);
      `);
      vm.runTimers();
      expect(logs.map((l) => l.message)).toEqual(["a", "b"]);
    } finally {
      vm.dispose();
    }
  });

  it("honours clearTimeout", () => {
    const { vm, logs } = harness();
    try {
      vm.evaluate(
        `const id = setTimeout(() => __writer.log("info", "nope"), 0); clearTimeout(id);`,
      );
      vm.runTimers();
      expect(logs).toHaveLength(0);
    } finally {
      vm.dispose();
    }
  });

  it("carries structured payloads across the boundary as JSON", () => {
    const { vm, commits } = harness();
    try {
      // Guards the `dump()` hazard: a plain object crosses as the literal
      // string "[object Object]" unless the guest stringifies first.
      vm.evaluate(
        `__writer.commit(JSON.stringify({ revision: 7, root: [{ id: 1, type: "List" }] }))`,
      );
      expect(commits[0]).toEqual({ revision: 7, root: [{ id: 1, type: "List" }] });
    } finally {
      vm.dispose();
    }
  });

  it("surfaces guest throws as host errors instead of swallowing them", () => {
    const { vm } = harness();
    try {
      expect(() => vm.evaluate(`throw new Error("boom")`)).toThrow(/boom/);
    } finally {
      vm.dispose();
    }
  });

  it("halts an infinite loop via the interrupt handler", () => {
    const vm = new ExtensionVm(
      wasm,
      { onCommit: () => {}, onLog: () => {}, onCapability: () => {}, onToast: () => {} },
      { memoryBytes: 16 * 1024 * 1024, budgetMs: 150 },
    );
    try {
      const started = Date.now();
      expect(() => vm.evaluate(`while (true) {}`)).toThrow();
      // The guest cannot catch an interrupt, so this must return promptly.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      vm.dispose();
    }
  });

  it("routes capability requests out with their call id", () => {
    const { vm, capabilities } = harness();
    try {
      vm.evaluate(
        `__writer.capability(42, JSON.stringify({ capability: "workspace", method: "read", args: ["a.md"] }))`,
      );
      expect(capabilities[0]).toEqual({
        callId: 42,
        request: { capability: "workspace", method: "read", args: ["a.md"] },
      });
    } finally {
      vm.dispose();
    }
  });

  it("disposes cleanly after heavy handle churn", () => {
    // A leaked handle makes dispose() abort the WASM module with
    // "Assertion failed: list_empty(&rt->gc_obj_list)", so a clean return here
    // is the actual assertion.
    const { vm } = harness();
    vm.evaluate(`
      for (let i = 0; i < 200; i++) {
        setTimeout(() => __writer.log("debug", "t" + i), i % 5);
      }
      __writer.commit(JSON.stringify({ revision: 1, root: [] }));
    `);
    vm.runTimers();
    expect(() => vm.dispose()).not.toThrow();
  });

  it("refuses to run after disposal instead of crashing the worker", () => {
    const { vm } = harness();
    vm.dispose();
    expect(() => vm.evaluate(`1 + 1`)).toThrow(/disposed/);
    expect(() => vm.dispose()).not.toThrow();
  });

  it("enforces the memory limit rather than growing without bound", () => {
    const vm = new ExtensionVm(
      wasm,
      { onCommit: () => {}, onLog: () => {}, onCapability: () => {}, onToast: () => {} },
      { memoryBytes: 1024 * 1024, budgetMs: 2_000 },
    );
    try {
      expect(() =>
        vm.evaluate(`const a = []; while (true) { a.push(new Array(10000).fill("x")); }`),
      ).toThrow();
    } finally {
      vm.dispose();
    }
  });
});
