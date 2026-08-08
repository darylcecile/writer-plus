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

/**
 * Asks the user about a runtime-tier permission and returns what they chose.
 *
 * Injected rather than imported so this module never reaches for a DOM, and
 * so tests can answer without rendering anything.
 */
export type ApprovalPrompt = (
  extensionId: string,
  permissionKey: string,
) => Promise<"once" | "always" | "never">;

export interface BrokerOptions {
  invoke: RustInvoke;
  /** extensionId -> permissions granted at install. */
  grants: Map<string, GrantedPermissions>;
  routeService?: ServiceRouter;
  /**
   * Asks the user about a runtime-tier permission. When absent, a call
   * needing approval is refused rather than silently allowed - a host with no
   * way to ask has no way to obtain consent.
   */
  requestApproval?: ApprovalPrompt;
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
  /** In-flight approval dialogs, keyed by extension + permission. */
  const pendingPrompts = new Map<string, Promise<"once" | "always" | "never">>();

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

      const permissionKey = approvalKey(message);
      if (permissionKey !== null) {
        return askThenRetry(extensionId, instanceId, request, permissionKey);
      }

      const code = message.startsWith("denied:") ? "denied" : "failed";
      return { ok: false, code, message };
    }
  };

  /**
   * Asks the user about a runtime-tier permission, then retries the call once.
   *
   * Exactly once. Rust is the authority, so if it still refuses after a
   * recorded grant something is wrong and looping would turn that into a hang
   * - or, with a prompt in the loop, an inescapable dialog.
   */
  async function askThenRetry(
    extensionId: string,
    instanceId: string,
    request: CapabilityRequest,
    permissionKey: string,
  ): Promise<CapabilityResult> {
    if (!options.requestApproval) {
      return denied(`${permissionKey} needs approval but this host cannot ask`);
    }

    const decision = await sharedPrompt(extensionId, permissionKey, options.requestApproval);
    if (decision === "never") {
      return denied(`${permissionKey} was declined`);
    }

    try {
      await options.invoke("extension_grant_set", { extensionId, key: permissionKey, decision });
    } catch (err) {
      // The decision could not be recorded, so Rust will refuse again.
      // Reporting that honestly beats a retry that fails for a reason the
      // user cannot connect to what they just clicked.
      return { ok: false, code: "failed", message: describe(err) };
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
      const message = describe(err);
      return { ok: false, code: message.startsWith("denied:") ? "denied" : "failed", message };
    }
  }

  /**
   * One dialog per extension+permission, however many calls are waiting.
   *
   * An extension writing in a loop hits the gate once per call. Without this
   * every one of those opens its own dialog, which is both unusable and a way
   * to bully a user into clicking allow just to clear the screen.
   */
  function sharedPrompt(
    extensionId: string,
    permissionKey: string,
    ask: ApprovalPrompt,
  ): Promise<"once" | "always" | "never"> {
    const cacheKey = `${extensionId}\u0000${permissionKey}`;
    const existing = pendingPrompts.get(cacheKey);
    if (existing) return existing;

    const prompt = ask(extensionId, permissionKey).finally(() => {
      pendingPrompts.delete(cacheKey);
    });
    pendingPrompts.set(cacheKey, prompt);
    return prompt;
  }
}

/**
 * The permission key Rust says needs approval, or `null` for any other error.
 *
 * The prefix is pinned by a Rust test, because it is the only thing carrying
 * this distinction across the boundary.
 */
function approvalKey(message: string): string | null {
  const prefix = "needs-approval: ";
  const at = message.indexOf(prefix);
  if (at === -1) return null;
  const key = message.slice(at + prefix.length).trim();
  return key.length > 0 ? key : null;
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
