/**
 * Capability broker - the TypeScript half of the permission gate.
 *
 * Every request an extension makes passes through here. This layer answers
 * "is this extension allowed to ask?" using the manifest it was installed
 * with; Rust independently answers "is this specific argument allowed?"
 * (path containment, size limits, and so on).
 *
 * Both checks are required. This one alone is not a security boundary: the
 * renderer is not trusted, so a compromised renderer could call Rust
 * directly. Rust re-validating is what makes the gate real. What this layer
 * buys is a fast, honest refusal and a single place to apply consent
 * prompts, so Rust never has to know about UI.
 */

import type {
  CapabilityRequest,
  CapabilityResult,
  JsonValue,
} from "@writer/extension-api/protocol";

/** Permissions as declared in an extension manifest. */
export interface GrantedPermissions {
  /** Capability namespaces the user approved at install time. */
  capabilities: string[];
  /** Extension ids whose services this extension may call. */
  usesServices: string[];
  /** Service names this extension offers to others. */
  providesServices: string[];
}

/** Invokes a Rust capability command. Injected so this stays testable. */
export type RustInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Resolves a service call to the extension instance that provides it. */
export type ServiceRouter = (
  serviceName: string,
  method: string,
  args: JsonValue[],
) => Promise<CapabilityResult>;

export interface BrokerOptions {
  invoke: RustInvoke;
  /** extensionId -> permissions granted at install. */
  grants: Map<string, GrantedPermissions>;
  routeService?: ServiceRouter;
  /** Wall-clock ceiling for a single capability call. */
  timeoutMs?: number;
}

/**
 * Capabilities that are pure host-side UI and never reach Rust. Kept
 * explicit rather than inferred: an unlisted capability must fail closed.
 */
const UI_CAPABILITIES = new Set(["ui"]);

const DEFAULT_TIMEOUT_MS = 30_000;

export function createBroker(options: BrokerOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function broker(
    instanceId: string,
    extensionId: string,
    request: CapabilityRequest,
  ): Promise<CapabilityResult> {
    const grant = options.grants.get(extensionId);
    if (!grant) {
      return denied(`extension ${extensionId} has no granted permissions`);
    }

    // `services` is routed peer-to-peer and checked against usesServices,
    // not against the capability list, so it is handled before the generic
    // namespace check.
    if (request.capability === "services") {
      return routeServiceCall(options, grant, request, timeoutMs);
    }

    if (!grant.capabilities.includes(request.capability)) {
      return denied(`capability "${request.capability}" was not granted to ${extensionId}`);
    }

    if (UI_CAPABILITIES.has(request.capability)) {
      // No UI capability currently needs host state, but the branch exists so
      // adding one does not accidentally send it to Rust.
      return { ok: false, code: "unavailable", message: `ui.${request.method} is not implemented` };
    }

    try {
      const value = await withTimeout(
        options.invoke("extension_capability", {
          instanceId,
          extensionId,
          capability: request.capability,
          method: request.method,
          args: request.args,
        }),
        timeoutMs,
        `${request.capability}.${request.method}`,
      );
      return { ok: true, value: value as JsonValue };
    } catch (err) {
      if (err instanceof TimeoutError) {
        return { ok: false, code: "timeout", message: err.message };
      }
      // Rust returns denials as errors carrying a code; preserve the
      // distinction so the guest can tell "not allowed" from "broke".
      const message = describe(err);
      const code = message.startsWith("denied:") ? "denied" : "failed";
      return { ok: false, code, message };
    }
  };
}

async function routeServiceCall(
  options: BrokerOptions,
  grant: GrantedPermissions,
  request: CapabilityRequest,
  timeoutMs: number,
): Promise<CapabilityResult> {
  if (!options.routeService) {
    return { ok: false, code: "unavailable", message: "service routing is not configured" };
  }

  // request.method is `provider/serviceMethod`; the provider half is what the
  // user consented to when linking the two extensions.
  const slash = request.method.indexOf("/");
  if (slash <= 0) {
    return {
      ok: false,
      code: "invalid",
      message: `service method must be "service/method", got "${request.method}"`,
    };
  }

  const serviceName = request.method.slice(0, slash);
  const method = request.method.slice(slash + 1);

  if (!grant.usesServices.includes(serviceName)) {
    return denied(`service "${serviceName}" is not in usesServices`);
  }

  try {
    return await withTimeout(
      options.routeService(serviceName, method, request.args),
      timeoutMs,
      `services.${request.method}`,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      return { ok: false, code: "timeout", message: err.message };
    }
    return { ok: false, code: "failed", message: describe(err) };
  }
}

function denied(message: string): CapabilityResult {
  return { ok: false, code: "denied", message };
}

class TimeoutError extends Error {}

/**
 * A capability that never settles would strand the guest promise forever and
 * leak the VM callback with it, so every call gets a deadline.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new TimeoutError(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}
