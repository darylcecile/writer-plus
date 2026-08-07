/**
 * Service routing between two live VMs.
 *
 * This is the path AI Chat uses to reach semantic-index, and it is the one
 * place where one extension's code can influence another's. The tests below
 * care less about the happy path than about what happens when the provider
 * misbehaves: a broken provider must never be able to take down its consumer.
 */

import { describe, expect, it, beforeAll } from "vitest";
import { getQuickJS } from "quickjs-emscripten";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { ExtensionManager } from "../src/manager.js";
import type { CapabilityResult, JsonValue } from "@writer/extension-api/protocol";

let wasm: QuickJSWASMModule;
beforeAll(async () => {
  wasm = await getQuickJS();
});

/**
 * A minimal guest that registers a service, written directly against the
 * `__writer_guest` contract rather than through the React runtime. Using the
 * real runtime here would test the reconciler again; what we want to pin is
 * the manager <-> guest service handshake on its own.
 */
function providerGuest(body: string): string {
  return `
    globalThis.__writer_guest = {
      register() {},
      mount() {},
      event() {},
      capabilityResult() {},
      flush() {},
      dispose() {},
      async service(name, method, argsJson) {
        const args = JSON.parse(argsJson);
        ${body}
      },
    };
  `;
}

function makeManager() {
  const errors: string[] = [];
  const manager = new ExtensionManager(
    wasm,
    // No capability should be requested in these tests. Failing loudly rather
    // than returning a polite refusal means an unexpected request shows up as
    // a broken test instead of quietly passing.
    async () => {
      throw new Error("no capability should be requested by a service test");
    },
    {
      onCommit: () => {},
      onError: (_id, message) => errors.push(message),
      onLog: () => {},
      onToast: () => {},
    },
  );
  return { manager, errors };
}

async function call(
  manager: ExtensionManager,
  id: string,
  args: JsonValue[] = [],
): Promise<CapabilityResult> {
  return manager.callService(id, "search", "query", args);
}

describe("service routing", () => {
  it("returns a value the provider resolves synchronously", async () => {
    const { manager } = makeManager();
    manager.spawn(
      "p",
      "provider",
      providerGuest(`return JSON.stringify({ ok: true, value: { hits: args[0] } });`),
    );

    const result = await call(manager, "p", ["notes"]);

    expect(result).toEqual({ ok: true, value: { hits: "notes" } });
    manager.dispose("p");
  });

  it("resolves through an await, not just an immediate return", async () => {
    // A provider that awaits is the realistic case, and it is exactly what
    // fails if pending jobs are never drained.
    const { manager } = makeManager();
    manager.spawn(
      "p",
      "provider",
      providerGuest(`
        await Promise.resolve();
        await Promise.resolve();
        return JSON.stringify({ ok: true, value: "after await" });
      `),
    );

    const result = await call(manager, "p");

    expect(result).toEqual({ ok: true, value: "after await" });
    manager.dispose("p");
  });

  it("reports a refusal instead of throwing when the provider is not running", async () => {
    const { manager } = makeManager();

    const result = await call(manager, "missing");

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "unavailable" });
  });

  it("converts a provider exception into a refusal", async () => {
    const { manager } = makeManager();
    manager.spawn("p", "provider", providerGuest(`throw new Error("provider exploded");`));

    const result = await call(manager, "p");

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "failed" });
    expect(String((result as { message: string }).message)).toContain("provider exploded");
    manager.dispose("p");
  });

  it("does not hang when the provider never settles", async () => {
    // A provider awaiting a capability it will never receive must not strand
    // the consumer: the consumer gets a refusal it can render.
    const { manager } = makeManager();
    manager.spawn("p", "provider", providerGuest(`await new Promise(() => {}); return "";`));

    const result = await call(manager, "p");

    expect(result.ok).toBe(false);
    expect(String((result as { message: string }).message)).toContain("did not settle");
    manager.dispose("p");
  });

  it("keeps the provider usable after a failed call", async () => {
    // One bad call must not poison the VM - otherwise a single malformed
    // consumer request would permanently disable a shared provider.
    const { manager } = makeManager();
    manager.spawn(
      "p",
      "provider",
      providerGuest(`
        if (args[0] === "bad") throw new Error("nope");
        return JSON.stringify({ ok: true, value: "fine" });
      `),
    );

    const bad = await call(manager, "p", ["bad"]);
    const good = await call(manager, "p", ["good"]);

    expect(bad.ok).toBe(false);
    expect(good).toEqual({ ok: true, value: "fine" });
    manager.dispose("p");
  });

  it("refuses calls to a disposed provider rather than reaching into freed memory", async () => {
    const { manager } = makeManager();
    manager.spawn("p", "provider", providerGuest(`return JSON.stringify({ ok: true, value: 1 });`));
    manager.dispose("p");

    const result = await call(manager, "p");

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "unavailable" });
  });
});
