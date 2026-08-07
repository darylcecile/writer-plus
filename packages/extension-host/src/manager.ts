/**
 * Extension instance manager.
 *
 * Owns the lifecycle of every running extension VM and is the single place
 * capability requests are routed. It deliberately knows nothing about *how*
 * a capability is fulfilled - that is the broker's job - so the security
 * decision stays in one place instead of being spread across call sites.
 */

import type {
  CapabilityRequest,
  CapabilityResult,
  HostTree,
  JsonValue,
} from "@writer/extension-api/protocol";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { DEFAULT_LIMITS, ExtensionVm, type VmLimits } from "./vm.js";

/** Fulfils a capability request, or refuses it. */
export type CapabilityBroker = (
  instanceId: string,
  extensionId: string,
  request: CapabilityRequest,
) => Promise<CapabilityResult>;

export interface InstanceEvents {
  onCommit(instanceId: string, tree: HostTree): void;
  onLog(instanceId: string, level: string, message: string): void;
  onToast(instanceId: string, style: string, title: string, message?: string): void;
  onError(instanceId: string, message: string, fatal: boolean): void;
}

interface Instance {
  id: string;
  extensionId: string;
  vm: ExtensionVm;
  /** Latest revision committed. Guards against out-of-order frames. */
  revision: number;
  disposed: boolean;
}

export class ExtensionManager {
  private instances = new Map<string, Instance>();

  constructor(
    private readonly wasm: QuickJSWASMModule,
    private readonly broker: CapabilityBroker,
    private readonly events: InstanceEvents,
    private readonly limits: VmLimits = DEFAULT_LIMITS,
  ) {}

  /**
   * Create a VM and evaluate the extension bundle in it.
   *
   * A failure here disposes the VM before rethrowing: a half-initialized VM
   * still holds WASM handles, and leaking those aborts the whole module.
   */
  spawn(instanceId: string, extensionId: string, code: string): void {
    if (this.instances.has(instanceId)) {
      throw new Error(`instance ${instanceId} already exists`);
    }

    const instance: Instance = {
      id: instanceId,
      extensionId,
      vm: null as unknown as ExtensionVm,
      revision: -1,
      disposed: false,
    };

    instance.vm = new ExtensionVm(
      this.wasm,
      {
        onCommit: (tree) => this.handleCommit(instance, tree),
        onLog: (level, message) => this.events.onLog(instanceId, level, message),
        onToast: (style, title, message) => this.events.onToast(instanceId, style, title, message),
        onCapability: (callId, request) => {
          void this.handleCapability(instance, callId, request);
        },
      },
      this.limits,
    );

    this.instances.set(instanceId, instance);

    try {
      instance.vm.evaluate(code, `${extensionId}.js`);
    } catch (err) {
      this.dispose(instanceId);
      throw err;
    }
  }

  /** Mount a command's UI. Errors are reported, not thrown, so one bad extension cannot take down the panel. */
  mount(instanceId: string, command: string, props: Record<string, JsonValue> = {}): void {
    this.withInstance(instanceId, (instance) => {
      instance.vm.callGuest("mount", [command, props]);
      instance.vm.runTimers();
    });
  }

  /** Deliver a UI event to the guest, then drain whatever it scheduled. */
  dispatchEvent(instanceId: string, handlerId: string, args: JsonValue[]): void {
    this.withInstance(instanceId, (instance) => {
      instance.vm.callGuest("event", [handlerId, args]);
      instance.vm.runTimers();
    });
  }

  dispose(instanceId: string): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    instance.disposed = true;
    this.instances.delete(instanceId);
    try {
      instance.vm.dispose();
    } catch (err) {
      // Disposal failure is unrecoverable for this VM but must not stop us
      // from removing it; surfacing it is all we can usefully do.
      this.events.onError(instanceId, `dispose failed: ${describe(err)}`, true);
    }
  }

  disposeAll(): void {
    for (const id of [...this.instances.keys()]) this.dispose(id);
  }

  has(instanceId: string): boolean {
    return this.instances.has(instanceId);
  }

  // -------------------------------------------------------------- internals

  private handleCommit(instance: Instance, tree: HostTree): void {
    // Commits are produced synchronously but delivered across an async
    // boundary, so a stale frame can arrive after a newer one. Dropping it
    // is correct: the tree is a full snapshot, not a patch.
    if (tree.revision <= instance.revision) return;
    instance.revision = tree.revision;
    this.events.onCommit(instance.id, tree);
  }

  private async handleCapability(
    instance: Instance,
    callId: number,
    request: CapabilityRequest,
  ): Promise<void> {
    let result: CapabilityResult;
    try {
      result = await this.broker(instance.id, instance.extensionId, request);
    } catch (err) {
      result = { ok: false, code: "failed", message: describe(err) };
    }

    // The VM may have been disposed while the capability was in flight.
    // Resolving into a freed context is a use-after-free at the WASM level.
    if (instance.disposed || !this.instances.has(instance.id)) return;

    try {
      instance.vm.resolveCapability(callId, result);
      instance.vm.runTimers();
    } catch (err) {
      this.events.onError(instance.id, `capability resolve failed: ${describe(err)}`, true);
    }
  }

  private withInstance(instanceId: string, fn: (instance: Instance) => void): void {
    const instance = this.instances.get(instanceId);
    if (!instance) {
      this.events.onError(instanceId, "no such instance", false);
      return;
    }
    try {
      fn(instance);
    } catch (err) {
      // A budget overrun or an uncaught guest throw lands here. It is fatal
      // for the current interaction but the instance stays usable, so the
      // user can retry rather than losing the panel.
      this.events.onError(instanceId, describe(err), false);
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
