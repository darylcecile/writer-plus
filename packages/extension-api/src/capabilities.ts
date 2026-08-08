/**
 * Capability stubs. Each call is a request the Rust permission gate can and
 * will refuse; nothing here is authority in itself. A rejection surfaces as
 * `CapabilityError` with code `denied`.
 *
 * Note what is deliberately absent from the *sandboxed* surface: no raw path
 * access, no shell, no arbitrary SQL. Every method is something the gate knows
 * how to scope-check. The one exception is `process`, which is gated on the
 * `unsafe` capability and is a trust decision rather than a scope check — see
 * its doc comment.
 */

import { bridge } from "./runtime/bridge";
import type {
  IndexStatus,
  NoteContent,
  NoteRef,
  ProcessOutput,
  SearchHit,
  SemanticHit,
} from "./types";
import type { JsonValue } from "./protocol";

export { CapabilityError } from "./runtime/bridge";

/** Workspace access. Every path is resolved and scope-checked in Rust against
 *  the canonicalized real path, so `../` and symlinks cannot escape a grant. */
export const workspace = {
  search(query: string, limit = 30): Promise<SearchHit[]> {
    return bridge.invoke("workspace", "search", [query, limit]);
  },
  read(path: string): Promise<NoteContent> {
    return bridge.invoke("workspace", "read", [path]);
  },
  write(path: string, content: string): Promise<void> {
    return bridge.invoke("workspace", "write", [path, content]);
  },
  list(globPattern?: string): Promise<NoteRef[]> {
    return bridge.invoke("workspace", "list", [globPattern ?? null]);
  },
  recent(limit = 20): Promise<NoteRef[]> {
    return bridge.invoke("workspace", "recent", [limit]);
  },
  findByName(name: string): Promise<string | null> {
    return bridge.invoke("workspace", "findByName", [name]);
  },
  /** Absolute path of the open workspace, or null in standalone mode. */
  root(): Promise<string | null> {
    return bridge.invoke("workspace", "root", []);
  },
};

/** Per-extension key/value storage, namespaced by extension id in Rust.
 *  Reading another extension's namespace is not expressible here. */
export const storage = {
  get<T = JsonValue>(key: string): Promise<T | null> {
    return bridge.invoke("storage", "get", [key]);
  },
  set(key: string, value: JsonValue): Promise<void> {
    return bridge.invoke("storage", "set", [key, value]);
  },
  remove(key: string): Promise<void> {
    return bridge.invoke("storage", "remove", [key]);
  },
  keys(): Promise<string[]> {
    return bridge.invoke("storage", "keys", []);
  },
};

/** Values for the manifest's `preferences`, resolved at mount. */
export const preferences = {
  all<T extends Record<string, JsonValue>>(): Promise<T> {
    return bridge.invoke("preferences", "all", []);
  },
  get<T = JsonValue>(name: string): Promise<T | null> {
    return bridge.invoke("preferences", "get", [name]);
  },
};

/**
 * Raw child-process control. **Only available to extensions that declare the
 * `unsafe` capability.** A spawned process runs as the user with no sandbox:
 * Writer cannot contain it, so this is not a fine-grained gate but a trust
 * decision the user makes once, per extension, with the extension's stated
 * reason shown verbatim.
 *
 * There is deliberately no program allowlist. A permitted interpreter runs
 * arbitrary code and a permitted shell runs anything, so a partial gate would
 * imply a guarantee that does not exist.
 */
export const process = {
  /** Resolve a program name on the user's login-shell PATH. Returns the
   *  absolute path, or null when it is not installed. */
  which(program: string): Promise<string | null> {
    return bridge.invoke("process", "which", [program]);
  },
  /** Start a child process. The handle is namespaced to this extension. */
  spawn(program: string, args: string[] = [], options?: { cwd?: string }): Promise<string> {
    return bridge.invoke("process", "spawn", [
      program,
      args as unknown as JsonValue,
      (options ?? {}) as JsonValue,
    ]);
  },
  /** Write to the child's stdin. Bytes are sent verbatim; add your own
   *  newline if the protocol is line-delimited. */
  write(handle: string, data: string): Promise<void> {
    return bridge.invoke("process", "write", [handle, data]);
  },
  /**
   * Drain whatever the child has emitted since the last read. Non-blocking:
   * an idle child yields empty arrays, so callers poll. `exitCode` is null
   * while the process is still running.
   */
  read(handle: string): Promise<ProcessOutput> {
    return bridge.invoke("process", "read", [handle]);
  },
  /** Terminate the child and release the handle. */
  kill(handle: string): Promise<void> {
    return bridge.invoke("process", "kill", [handle]);
  },
};

/** Local semantic index (sqlite-vec + on-device embeddings). Requires
 *  `embeddings.write` to mutate; querying needs only the base capability. */
export const embeddings = {
  query(text: string, limit = 8): Promise<SemanticHit[]> {
    return bridge.invoke("embeddings", "query", [text, limit]);
  },
  status(): Promise<IndexStatus> {
    return bridge.invoke("embeddings", "status", []);
  },
  /** Incrementally index changed notes. Resolves when the pass completes. */
  reindex(options?: { force?: boolean }): Promise<IndexStatus> {
    return bridge.invoke("embeddings", "reindex", [(options ?? {}) as JsonValue]);
  },
  clear(): Promise<void> {
    return bridge.invoke("embeddings", "clear", []);
  },
};

/** Inter-extension RPC. The consumer names the provider in its manifest and
 *  the user consents to the link at install time. */
export const services = {
  call<T = JsonValue>(
    extensionId: string,
    service: string,
    method: string,
    args: JsonValue[] = [],
  ): Promise<T> {
    return bridge.invoke("services", "call", [extensionId, service, method, args]);
  },
  /** Providers register handlers at module scope; the host routes to them. */
  provide(service: string, methods: Record<string, (...args: never[]) => unknown>): void {
    registerService(service, methods as Record<string, (...args: unknown[]) => unknown>);
  },
};

const serviceRegistry = new Map<string, Record<string, (...args: unknown[]) => unknown>>();

function registerService(
  name: string,
  methods: Record<string, (...args: unknown[]) => unknown>,
): void {
  serviceRegistry.set(name, methods);
}

/** Called by the guest bootstrap when the host routes a service call in. */
export async function dispatchService(
  service: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const impl = serviceRegistry.get(service);
  if (!impl) throw new Error(`service '${service}' is not provided by this extension`);
  const fn = impl[method];
  if (typeof fn !== "function") throw new Error(`service '${service}' has no method '${method}'`);
  return await fn(...args);
}

export const clipboard = {
  copy(text: string): Promise<void> {
    return bridge.invoke("clipboard", "copy", [text]);
  },
  read(): Promise<string> {
    return bridge.invoke("clipboard", "read", []);
  },
};

/** Host-mediated fetch, restricted to the manifest's domain allowlist. There
 *  is no `fetch` in the VM, so this is the only egress. */
export const net = {
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return bridge.invoke("network", "fetch", [url, (init ?? {}) as JsonValue]);
  },
};
