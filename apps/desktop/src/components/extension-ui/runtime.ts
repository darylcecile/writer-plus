/**
 * Main-thread entry point for the extension system.
 *
 * Loads the QuickJS module once and hands out a manager wired to a broker that
 * forwards to Rust. The WASM variant is preferred and the asm.js variant is a
 * fallback: WebKit enforces CSP for WebAssembly, so a stricter policy than the
 * one this app ships would block WASM outright, and silently having no
 * extensions at all is a worse outcome than running the slower build.
 */

import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { invoke } from "@tauri-apps/api/core";
import type { CapabilityResult, HostTree, JsonValue } from "@writer/extension-api/protocol";
import { ExtensionManager, createBroker, type GrantedPermissions } from "@writer/extension-host";

export type Engine = "wasm" | "asmjs";

let modulePromise: Promise<{ wasm: QuickJSWASMModule; engine: Engine }> | null = null;

/**
 * Load the QuickJS module, at most once per session.
 *
 * The failure path matters: if WASM is blocked we want to know *which* engine
 * ended up running, because a silent fallback would hide a CSP regression
 * behind nothing more visible than slower extensions.
 */
export function loadQuickJs(): Promise<{ wasm: QuickJSWASMModule; engine: Engine }> {
  modulePromise ??= (async () => {
    try {
      const variant = await import("@jitl/quickjs-wasmfile-release-sync");
      const wasm = await newQuickJSWASMModuleFromVariant(variant.default);
      return { wasm, engine: "wasm" as const };
    } catch (wasmError) {
      console.warn("[extensions] WASM engine unavailable, falling back to asm.js", wasmError);
      const variant = await import("@jitl/quickjs-asmjs-mjs-release-sync");
      const wasm = await newQuickJSWASMModuleFromVariant(variant.default);
      return { wasm, engine: "asmjs" as const };
    }
  })();
  return modulePromise;
}

export interface InstalledExtension {
  id: string;
  name: string;
  code: string;
  permissions: GrantedPermissions;
}

export interface ExtensionRuntime {
  manager: ExtensionManager;
  engine: Engine;
  /** Latest committed tree per instance. */
  trees: Map<string, HostTree>;
}

export interface RuntimeEvents {
  onTree(instanceId: string, tree: HostTree): void;
  onError(instanceId: string, message: string, fatal: boolean): void;
  onToast(style: string, title: string, message?: string): void;
}

/**
 * Build a runtime over a set of installed extensions.
 *
 * Service routing is resolved here because only this layer knows which
 * instance is currently hosting a given provider; the broker deliberately
 * stays ignorant of instance topology.
 */
export async function createRuntime(
  installed: InstalledExtension[],
  events: RuntimeEvents,
): Promise<ExtensionRuntime> {
  const { wasm, engine } = await loadQuickJs();

  const grants = new Map<string, GrantedPermissions>();
  for (const ext of installed) grants.set(ext.id, ext.permissions);

  /** provider extension id -> its instance id. */
  const providers = new Map<string, string>();
  const trees = new Map<string, HostTree>();

  const broker = createBroker({
    invoke: (command, args) => invoke(command, args),
    grants,
    routeService: async (serviceName, method, args) => {
      const instanceId = providers.get(serviceName);
      if (!instanceId) {
        return {
          ok: false,
          code: "unavailable",
          message: `no running extension provides "${serviceName}"`,
        } satisfies CapabilityResult;
      }
      return manager.callService(instanceId, serviceName, method, args);
    },
  });

  const manager = new ExtensionManager(wasm, broker, {
    onCommit: (instanceId, tree) => {
      trees.set(instanceId, tree);
      events.onTree(instanceId, tree);
    },
    onError: (instanceId, message, fatal) => events.onError(instanceId, message, fatal),
    onLog: (instanceId, level, message) => {
      if (level === "error") console.error(`[ext ${instanceId}]`, message);
    },
    onToast: (_instanceId, style, title, message) => events.onToast(style, title, message),
    onDispose: (_instanceId, extensionId) => {
      // Fire-and-forget: the VM is going away either way, and a failed reap
      // must not block that. Rust owns the kill because a guest that crashed
      // or blew its CPU budget never gets to run its own teardown.
      void invoke("extension_reap", { extensionId }).catch(() => {});
    },
  });

  for (const ext of installed) {
    const instanceId = ext.id;
    try {
      manager.spawn(instanceId, ext.id, ext.code);
      for (const service of ext.permissions.providesServices) {
        providers.set(service, instanceId);
      }
    } catch (err) {
      events.onError(instanceId, err instanceof Error ? err.message : String(err), true);
    }
  }

  return { manager, engine, trees };
}

/** Dispatch a UI event from a rendered tree back into its extension. */
export function makeDispatch(manager: ExtensionManager, instanceId: string) {
  return (handlerId: string, args: JsonValue[]) => {
    manager.dispatchEvent(instanceId, handlerId, args);
  };
}
