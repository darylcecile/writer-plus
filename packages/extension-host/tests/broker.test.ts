/**
 * Broker tests. These are permission-gate tests, so each one asserts a
 * *refusal* as carefully as it asserts a success - a gate that only gets
 * tested on the happy path is not tested at all.
 */

import { describe, expect, it, vi } from "vitest";
import { createBroker, type GrantedPermissions } from "../src/broker.js";

function grants(entries: Record<string, Partial<GrantedPermissions>>) {
  const map = new Map<string, GrantedPermissions>();
  for (const [id, g] of Object.entries(entries)) {
    map.set(id, {
      capabilities: g.capabilities ?? [],
      usesServices: g.usesServices ?? [],
      providesServices: g.providesServices ?? [],
    });
  }
  return map;
}

describe("capability broker", () => {
  it("refuses an extension with no grant record at all", async () => {
    const invoke = vi.fn();
    const broker = createBroker({ invoke, grants: grants({}) });

    const result = await broker("i1", "unknown.ext", {
      capability: "fs",
      method: "readFile",
      args: ["/notes/a.md"],
    });

    expect(result).toMatchObject({ ok: false, code: "denied" });
    // The important half: it must not have reached Rust.
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a capability outside the manifest without calling Rust", async () => {
    const invoke = vi.fn();
    const broker = createBroker({
      invoke,
      grants: grants({ "a.ext": { capabilities: ["ui"] } }),
    });

    const result = await broker("i1", "a.ext", {
      capability: "fs",
      method: "readFile",
      args: ["/etc/passwd"],
    });

    expect(result).toMatchObject({ ok: false, code: "denied" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("forwards a granted capability to Rust with the instance identity attached", async () => {
    const invoke = vi.fn().mockResolvedValue({ content: "# hello" });
    const broker = createBroker({
      invoke,
      grants: grants({ "a.ext": { capabilities: ["fs"] } }),
    });

    const result = await broker("i1", "a.ext", {
      capability: "fs",
      method: "readFile",
      args: ["/notes/a.md"],
    });

    expect(result).toEqual({ ok: true, value: { content: "# hello" } });
    // Rust must receive who is asking, not just what is asked, or it cannot
    // re-validate the request independently.
    expect(invoke).toHaveBeenCalledWith("extension_capability", {
      instanceId: "i1",
      extensionId: "a.ext",
      capability: "fs",
      method: "readFile",
      args: ["/notes/a.md"],
    });
  });

  it("preserves a Rust-side denial as denied rather than flattening it to failed", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("denied: path escapes workspace"));
    const broker = createBroker({
      invoke,
      grants: grants({ "a.ext": { capabilities: ["fs"] } }),
    });

    const result = await broker("i1", "a.ext", {
      capability: "fs",
      method: "readFile",
      args: ["../../secrets"],
    });

    expect(result).toMatchObject({ ok: false, code: "denied" });
  });

  it("reports a generic Rust error as failed", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("disk exploded"));
    const broker = createBroker({
      invoke,
      grants: grants({ "a.ext": { capabilities: ["fs"] } }),
    });

    const result = await broker("i1", "a.ext", {
      capability: "fs",
      method: "readFile",
      args: ["/notes/a.md"],
    });

    expect(result).toMatchObject({ ok: false, code: "failed", message: "disk exploded" });
  });

  it("times out a capability that never settles", async () => {
    // A hung capability would otherwise strand the guest promise forever and
    // leak the VM callback attached to it.
    const invoke = vi.fn(() => new Promise<never>(() => {}));
    const broker = createBroker({
      invoke,
      grants: grants({ "a.ext": { capabilities: ["fs"] } }),
      timeoutMs: 20,
    });

    const result = await broker("i1", "a.ext", {
      capability: "fs",
      method: "readFile",
      args: ["/notes/a.md"],
    });

    expect(result).toMatchObject({ ok: false, code: "timeout" });
  });
});

describe("service routing", () => {
  it("refuses a service the consumer did not declare", async () => {
    const routeService = vi.fn();
    const broker = createBroker({
      invoke: vi.fn(),
      routeService,
      grants: grants({ "chat.ext": { usesServices: [] } }),
    });

    const result = await broker("i1", "chat.ext", {
      capability: "services",
      method: "semantic-index/search",
      args: ["notes about rust"],
    });

    expect(result).toMatchObject({ ok: false, code: "denied" });
    expect(routeService).not.toHaveBeenCalled();
  });

  it("routes a declared service to its provider", async () => {
    const routeService = vi.fn().mockResolvedValue({ ok: true, value: [{ path: "a.md" }] });
    const broker = createBroker({
      invoke: vi.fn(),
      routeService,
      grants: grants({ "chat.ext": { usesServices: ["semantic-index"] } }),
    });

    const result = await broker("i1", "chat.ext", {
      capability: "services",
      method: "semantic-index/search",
      args: ["notes about rust"],
    });

    expect(result).toEqual({ ok: true, value: [{ path: "a.md" }] });
    expect(routeService).toHaveBeenCalledWith("semantic-index", "search", ["notes about rust"]);
  });

  it("rejects a malformed service method instead of guessing the provider", async () => {
    const broker = createBroker({
      invoke: vi.fn(),
      routeService: vi.fn(),
      grants: grants({ "chat.ext": { usesServices: ["semantic-index"] } }),
    });

    const result = await broker("i1", "chat.ext", {
      capability: "services",
      method: "search",
      args: [],
    });

    expect(result).toMatchObject({ ok: false, code: "invalid" });
  });

  it("does not let a service name be spoofed by a leading slash", async () => {
    // "/semantic-index/search" splits to an empty provider name. Accepting it
    // would let a consumer address a provider it never declared.
    const routeService = vi.fn();
    const broker = createBroker({
      invoke: vi.fn(),
      routeService,
      grants: grants({ "chat.ext": { usesServices: ["semantic-index"] } }),
    });

    const result = await broker("i1", "chat.ext", {
      capability: "services",
      method: "/semantic-index/search",
      args: [],
    });

    expect(result).toMatchObject({ ok: false, code: "invalid" });
    expect(routeService).not.toHaveBeenCalled();
  });
});

/**
 * Runtime-tier approval. Rust refuses a call that has no decision yet and says
 * so with a distinguishable error; the host's job is to ask, record, and retry
 * exactly once.
 *
 * These are consent tests, so each asserts what the *user* ends up authorising,
 * not just that the plumbing runs.
 */
describe("runtime permission prompts", () => {
  const needsApproval = (key: string) => new Error(`needs-approval: ${key}`);

  function writeGrant() {
    return grants({ "note.taker": { capabilities: ["workspace"] } });
  }

  it("asks the user and retries the call once when they allow it", async () => {
    const invoke = vi
      .fn()
      // The original call: Rust has no decision on file.
      .mockRejectedValueOnce(needsApproval("workspace.write"))
      // extension_grant_set
      .mockResolvedValueOnce(null)
      // The retry.
      .mockResolvedValueOnce(null);
    const requestApproval = vi.fn().mockResolvedValue("always");

    const broker = createBroker({ invoke, grants: writeGrant(), requestApproval });
    const result = await broker("i1", "note.taker", {
      capability: "workspace",
      method: "write",
      args: ["a.md", "hi"],
    });

    expect(result).toMatchObject({ ok: true });
    expect(requestApproval).toHaveBeenCalledWith("note.taker", "workspace.write");
    expect(invoke).toHaveBeenNthCalledWith(2, "extension_grant_set", {
      extensionId: "note.taker",
      key: "workspace.write",
      decision: "always",
    });
  });

  it("does not perform the action when the user declines", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(needsApproval("workspace.write"));
    const requestApproval = vi.fn().mockResolvedValue("never");

    const broker = createBroker({ invoke, grants: writeGrant(), requestApproval });
    const result = await broker("i1", "note.taker", {
      capability: "workspace",
      method: "write",
      args: ["a.md", "hi"],
    });

    expect(result).toMatchObject({ ok: false, code: "denied" });
    // The whole point: declining must not reach Rust again. A retry after a
    // refusal is how "no" quietly becomes "yes".
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("records allow-once as once, so it cannot be promoted to always", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(needsApproval("workspace.write"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    const requestApproval = vi.fn().mockResolvedValue("once");

    const broker = createBroker({ invoke, grants: writeGrant(), requestApproval });
    await broker("i1", "note.taker", { capability: "workspace", method: "write", args: [] });

    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "extension_grant_set",
      expect.objectContaining({ decision: "once" }),
    );
  });

  /**
   * An extension writing in a loop hits the gate on every call. One dialog per
   * call is unusable, and it is a way to bully a user into clicking allow just
   * to clear the screen.
   */
  it("opens one dialog for concurrent calls needing the same permission", async () => {
    const invoke = vi.fn().mockImplementation((command: string) => {
      if (command === "extension_grant_set") return Promise.resolve(null);
      // Every capability call is refused until a decision exists; the mock has
      // no state, so a second dialog would be the only way to proceed.
      return callCount++ < 3
        ? Promise.reject(needsApproval("workspace.write"))
        : Promise.resolve(null);
    });
    let callCount = 0;
    let resolvePrompt: ((d: "always") => void) | undefined;
    const requestApproval = vi.fn().mockImplementation(
      () =>
        new Promise<"always">((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    const broker = createBroker({ invoke, grants: writeGrant(), requestApproval });
    const calls = [0, 1, 2].map((n) =>
      broker("i1", "note.taker", { capability: "workspace", method: "write", args: [`${n}.md`] }),
    );

    await vi.waitFor(() => expect(resolvePrompt).toBeDefined());
    resolvePrompt?.("always");
    await Promise.all(calls);

    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  /** A host with no way to ask has no way to obtain consent. */
  it("refuses rather than allowing when the host cannot prompt", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(needsApproval("workspace.write"));

    const broker = createBroker({ invoke, grants: writeGrant() });
    const result = await broker("i1", "note.taker", {
      capability: "workspace",
      method: "write",
      args: [],
    });

    expect(result).toMatchObject({ ok: false, code: "denied" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  /**
   * Rust is the authority. If it still refuses after a recorded grant,
   * something is wrong - and retrying with a prompt in the loop would be an
   * inescapable dialog.
   */
  it("retries at most once and never re-prompts in a loop", async () => {
    const invoke = vi
      .fn()
      .mockImplementation((command: string) =>
        command === "extension_grant_set"
          ? Promise.resolve(null)
          : Promise.reject(needsApproval("workspace.write")),
      );
    const requestApproval = vi.fn().mockResolvedValue("always");

    const broker = createBroker({ invoke, grants: writeGrant(), requestApproval });
    const result = await broker("i1", "note.taker", {
      capability: "workspace",
      method: "write",
      args: [],
    });

    expect(result).toMatchObject({ ok: false });
    expect(requestApproval).toHaveBeenCalledTimes(1);
    // original + grant_set + one retry
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("reports honestly when the decision could not be saved", async () => {
    const invoke = vi
      .fn()
      .mockImplementation((command: string) =>
        command === "extension_grant_set"
          ? Promise.reject(new Error("keychain locked"))
          : Promise.reject(needsApproval("workspace.write")),
      );
    const requestApproval = vi.fn().mockResolvedValue("always");

    const broker = createBroker({ invoke, grants: writeGrant(), requestApproval });
    const result = await broker("i1", "note.taker", {
      capability: "workspace",
      method: "write",
      args: [],
    });

    expect(result).toMatchObject({ ok: false, code: "failed" });
    expect(result).toHaveProperty("message", expect.stringContaining("keychain locked"));
  });

  /** An ordinary refusal must not be mistaken for an unanswered prompt. */
  it("does not prompt for a plain denial", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("denied: path escapes workspace"));
    const requestApproval = vi.fn();

    const broker = createBroker({ invoke, grants: writeGrant(), requestApproval });
    const result = await broker("i1", "note.taker", {
      capability: "workspace",
      method: "write",
      args: ["../../etc/passwd"],
    });

    expect(result).toMatchObject({ ok: false, code: "denied" });
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
