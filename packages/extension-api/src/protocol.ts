/**
 * Wire protocol between the host (main thread), the extension host worker,
 * and the guest VM.
 *
 * Everything here must be structured-clone-safe on the worker boundary AND
 * JSON-serializable on the VM boundary. The VM boundary is the stricter of
 * the two, so JSON is the contract: no Map, Set, Date, undefined-in-array,
 * functions, or cycles. Callbacks cross as opaque string ids.
 *
 * This file is shared by guest and host so the two can never drift.
 */

// ---------------------------------------------------------------- UI tree

/** A node in the serialized UI tree the guest commits to the host. */
export interface HostNode {
  /** Monotonic per-VM instance id. Stable across commits for the same node. */
  id: number;
  /** Component name, e.g. `List`, `List.Item`. Must exist in the host registry. */
  type: string;
  props: Record<string, JsonValue>;
  /** Prop name -> callback id. Invoked via `event` messages. */
  handlers: Record<string, string>;
  children: HostNode[];
}

export interface HostTree {
  root: HostNode[];
  /** Incremented per commit; lets the host drop out-of-order frames. */
  revision: number;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ------------------------------------------------------- capability calls

/** Namespaced capability request. Always resolved by Rust, never by TS. */
export interface CapabilityRequest {
  capability: string;
  method: string;
  args: JsonValue[];
}

export interface CapabilityOk<T = JsonValue> {
  ok: true;
  value: T;
}
export interface CapabilityErr {
  ok: false;
  /** Machine-readable. `denied` specifically means the permission gate said no. */
  code: "denied" | "invalid" | "failed" | "timeout" | "unavailable";
  message: string;
}
export type CapabilityResult<T = JsonValue> = CapabilityOk<T> | CapabilityErr;

// ------------------------------------------------- main thread <-> worker

export type HostToWorker =
  | {
      t: "spawn";
      instanceId: string;
      extensionId: string;
      code: string;
      preferences: Record<string, JsonValue>;
    }
  | { t: "mount"; instanceId: string; command: string; props: Record<string, JsonValue> }
  | { t: "event"; instanceId: string; handlerId: string; args: JsonValue[] }
  | { t: "capability-result"; instanceId: string; callId: number; result: CapabilityResult }
  | { t: "dispose"; instanceId: string }
  | { t: "ping"; instanceId: string; nonce: number };

export type WorkerToHost =
  | { t: "ready" }
  | { t: "spawned"; instanceId: string }
  | { t: "commit"; instanceId: string; tree: HostTree }
  | { t: "capability"; instanceId: string; callId: number; request: CapabilityRequest }
  | { t: "log"; instanceId: string; level: "debug" | "info" | "warn" | "error"; message: string }
  | {
      t: "toast";
      instanceId: string;
      style: "success" | "failure" | "animated";
      title: string;
      message?: string;
    }
  | { t: "error"; instanceId: string; message: string; fatal: boolean }
  | { t: "pong"; instanceId: string; nonce: number };
