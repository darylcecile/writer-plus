/**
 * Manager tests, run against real QuickJS VMs.
 *
 * The interesting cases here are all lifecycle races: a capability resolving
 * after disposal, a stale commit arriving after a newer one, a spawn that
 * throws partway through. None of them are visible without a real VM, because
 * what makes them dangerous is WASM handle ownership.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import type { CapabilityResult, HostTree } from "@writer/extension-api/protocol";
import { ExtensionManager, type CapabilityBroker } from "../src/manager";

let wasm: QuickJSWASMModule;

beforeAll(async () => {
  wasm = await newQuickJSWASMModuleFromVariant(releaseSync);
});

function harness(broker?: CapabilityBroker) {
  const commits: { instanceId: string; tree: HostTree }[] = [];
  const errors: { instanceId: string; message: string; fatal: boolean }[] = [];
  const logs: { instanceId: string; level: string; message: string }[] = [];
  const toasts: unknown[] = [];

  const manager = new ExtensionManager(
    wasm,
    broker ?? (async () => ({ ok: false, code: "unavailable", message: "no broker" })),
    {
      onCommit: (instanceId, tree) => commits.push({ instanceId, tree }),
      onError: (instanceId, message, fatal) => errors.push({ instanceId, message, fatal }),
      onLog: (instanceId, level, message) => logs.push({ instanceId, level, message }),
      onToast: (...args) => toasts.push(args),
    },
  );

  return { manager, commits, errors, logs, toasts };
}

/** A minimal guest that speaks the host protocol without pulling in React. */
const STUB_GUEST = `
  let revision = 0;
  const handlers = {};
  globalThis.__writer_guest = {
    mount(command, props) {
      handlers.hit = () => { __writer.log("info", "hit:" + command); };
      __writer.commit(JSON.stringify({
        revision: ++revision,
        root: [{ id: 1, type: "List", props: { title: command }, handlers: { onAction: "hit" }, children: [] }],
      }));
    },
    event(handlerId) {
      const fn = handlers[handlerId];
      if (fn) fn();
    },
  };
`;

/**
 * A guest that issues a capability call. `__writer.capability` takes the call
 * id and a JSON string separately, and the guest owns its own pending map -
 * the host resolves it by calling back into `capabilityResult`.
 */
const CAPABILITY_GUEST = `
  const pending = new Map();
  let nextCallId = 1;
  globalThis.__writer_guest = {
    mount() {
      const callId = nextCallId++;
      pending.set(callId, (r) => { __writer.log("info", "got:" + JSON.stringify(r)); });
      __writer.capability(callId, JSON.stringify({ capability: "fs", method: "readFile", args: ["a.md"] }));
    },
    event() {},
    capabilityResult(callId, json) {
      const fn = pending.get(callId);
      pending.delete(callId);
      if (fn) fn(JSON.parse(json));
    },
  };
`;

describe("ExtensionManager", () => {
  it("spawns, mounts and delivers a commit", () => {
    const { manager, commits } = harness();
    manager.spawn("i1", "a.ext", STUB_GUEST);
    manager.mount("i1", "search", {});

    expect(commits).toHaveLength(1);
    expect(commits[0].instanceId).toBe("i1");
    expect(commits[0].tree.root[0].type).toBe("List");
    expect(commits[0].tree.root[0].props.title).toBe("search");

    manager.disposeAll();
  });

  it("routes an event back into the guest", () => {
    const { manager, logs } = harness();
    manager.spawn("i1", "a.ext", STUB_GUEST);
    manager.mount("i1", "search", {});
    manager.dispatchEvent("i1", "hit", []);

    expect(logs.map((l) => l.message)).toContain("hit:search");
    manager.disposeAll();
  });

  it("isolates instances from one another", () => {
    // Two VMs, one global name. If they shared a runtime the second spawn
    // would see the first's value.
    const { manager, logs } = harness();
    manager.spawn(
      "i1",
      "a.ext",
      `globalThis.secret = "one"; __writer.log("info", String(globalThis.secret));`,
    );
    manager.spawn("i2", "b.ext", `__writer.log("info", "sees:" + String(globalThis.secret));`);

    expect(logs.find((l) => l.instanceId === "i2")?.message).toBe("sees:undefined");
    manager.disposeAll();
  });

  it("refuses a duplicate instance id", () => {
    const { manager } = harness();
    manager.spawn("i1", "a.ext", STUB_GUEST);
    expect(() => manager.spawn("i1", "a.ext", STUB_GUEST)).toThrow(/already exists/);
    manager.disposeAll();
  });

  it("disposes the VM when the bundle throws during spawn", () => {
    // A half-initialized VM still holds WASM handles; leaking them aborts the
    // entire module, which would take down every other extension too.
    const { manager } = harness();
    expect(() => manager.spawn("i1", "a.ext", `throw new Error("bad bundle");`)).toThrow();
    expect(manager.has("i1")).toBe(false);

    // Proof the module is still healthy: another VM can start.
    manager.spawn("i2", "b.ext", STUB_GUEST);
    manager.mount("i2", "ok", {});
    manager.disposeAll();
  });

  it("drops a stale commit that arrives after a newer revision", () => {
    const { manager, commits } = harness();
    manager.spawn(
      "i1",
      "a.ext",
      `
      globalThis.__writer_guest = {
        mount() {
          const frame = (revision) => JSON.stringify({
            revision,
            root: [{ id: 1, type: "List", props: { r: revision }, handlers: {}, children: [] }],
          });
          __writer.commit(frame(5));
          __writer.commit(frame(3));
          __writer.commit(frame(6));
        },
        event() {},
      };
    `,
    );
    manager.mount("i1", "x", {});

    // The tree is a full snapshot, not a patch, so an older frame must be
    // discarded rather than applied.
    expect(commits.map((c) => c.tree.revision)).toEqual([5, 6]);
    manager.disposeAll();
  });

  it("reports a guest throw without killing the instance", () => {
    const { manager, errors, logs } = harness();
    manager.spawn(
      "i1",
      "a.ext",
      `
      globalThis.__writer_guest = {
        mount(cmd) {
          if (cmd === "boom") throw new Error("guest exploded");
          __writer.log("info", "ok:" + cmd);
        },
        event() {},
      };
    `,
    );

    manager.mount("i1", "boom", {});
    expect(errors).toHaveLength(1);
    expect(errors[0].fatal).toBe(false);

    // Still usable: the user can retry rather than losing the panel.
    manager.mount("i1", "fine", {});
    expect(logs.map((l) => l.message)).toContain("ok:fine");
    manager.disposeAll();
  });

  it("passes capability requests to the broker and resolves them in the guest", async () => {
    let resolveIt: (r: CapabilityResult) => void = () => {};
    const pending = new Promise<CapabilityResult>((r) => {
      resolveIt = r;
    });
    const broker = vi.fn(() => pending);

    const { manager, logs } = harness(broker as unknown as CapabilityBroker);
    manager.spawn("i1", "a.ext", CAPABILITY_GUEST);
    manager.mount("i1", "x", {});

    expect(broker).toHaveBeenCalledWith("i1", "a.ext", {
      capability: "fs",
      method: "readFile",
      args: ["a.md"],
    });

    resolveIt({ ok: true, value: "# hello" });
    await pending;
    await new Promise((r) => setTimeout(r, 0));

    expect(logs.some((l) => l.message.includes('"value":"# hello"'))).toBe(true);
    manager.disposeAll();
  });

  it("does not resolve a capability into a VM that was disposed while it was in flight", async () => {
    // Resolving into a freed context is a use-after-free at the WASM level,
    // and would abort the module rather than fail gracefully.
    let resolveIt: (r: CapabilityResult) => void = () => {};
    const pending = new Promise<CapabilityResult>((r) => {
      resolveIt = r;
    });

    const { manager, errors } = harness((() => pending) as unknown as CapabilityBroker);
    manager.spawn("i1", "a.ext", CAPABILITY_GUEST);
    manager.mount("i1", "x", {});

    manager.dispose("i1");
    resolveIt({ ok: true, value: 1 });
    await pending;
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toHaveLength(0);
  });

  it("converts a broker rejection into a failed result rather than an unhandled rejection", async () => {
    const broker: CapabilityBroker = async () => {
      throw new Error("broker blew up");
    };
    const { manager, logs } = harness(broker);
    manager.spawn("i1", "a.ext", CAPABILITY_GUEST);
    manager.mount("i1", "x", {});
    await new Promise((r) => setTimeout(r, 0));

    expect(logs.some((l) => l.message.includes("broker blew up"))).toBe(true);
    manager.disposeAll();
  });

  it("reports a dispatch to a missing instance instead of throwing", () => {
    const { manager, errors } = harness();
    manager.dispatchEvent("ghost", "h1", []);
    expect(errors[0]).toMatchObject({ instanceId: "ghost", fatal: false });
  });

  it("disposeAll leaves no live instances", () => {
    const { manager } = harness();
    manager.spawn("i1", "a.ext", STUB_GUEST);
    manager.spawn("i2", "b.ext", STUB_GUEST);
    manager.disposeAll();
    expect(manager.has("i1")).toBe(false);
    expect(manager.has("i2")).toBe(false);
  });
});
