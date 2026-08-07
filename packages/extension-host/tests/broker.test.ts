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
