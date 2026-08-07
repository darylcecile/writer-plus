/**
 * Manifest types + validation.
 *
 * `extension.schema.json` is the single source of truth, consumed by Rust via
 * `include_str!` and here for TS types — the same split the settings schema
 * uses. The validator below is intentionally a *convenience* check for the CLI
 * and dev-mode loading. It is NOT a security boundary: Rust re-validates every
 * manifest at install time, because a manifest arriving from GitHub must never
 * be trusted on the strength of a TypeScript check.
 */

export type CommandMode = "view" | "no-view";
export type CommandSurface = "palette" | "panel" | "sidebar";

export interface CommandManifest {
  name: string;
  title: string;
  subtitle?: string;
  description?: string;
  mode?: CommandMode;
  surface?: CommandSurface;
  keywords?: string[];
}

export interface PreferenceManifest {
  name: string;
  type: "text" | "password" | "checkbox" | "dropdown" | "number";
  title: string;
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  data?: { title: string; value: string }[];
}

export interface Capabilities {
  workspace?: { read?: string[]; write?: string[]; delete?: string[]; reason: string };
  network?: { domains?: string[]; reason: string };
  ai?: { reason: string };
  embeddings?: { write?: boolean; reason: string };
  clipboard?: { read?: boolean; write?: boolean; reason: string };
  storage?: { shared?: string[]; reason?: string };
  services?: {
    provides?: { name: string; description: string; methods: string[] }[];
    uses?: { extension: string; service: string; reason: string }[];
  };
}

export interface ExtensionManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  minWriterVersion?: string;
  author: string;
  license?: string;
  icon?: string;
  keywords?: string[];
  commands: CommandManifest[];
  preferences?: PreferenceManifest[];
  capabilities?: Capabilities;
}

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/;

/** Capabilities whose `reason` is shown verbatim at consent time. */
const REASON_REQUIRED = ["workspace", "network", "ai", "embeddings", "clipboard"] as const;

export function validateManifest(
  input: unknown,
): { ok: true; manifest: ExtensionManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const m = input as Partial<ExtensionManifest>;

  if (!m || typeof m !== "object") return { ok: false, errors: ["manifest must be an object"] };

  if (!m.id || !ID_RE.test(m.id)) errors.push("`id` must be kebab-case (a-z, 0-9, hyphens)");
  if (!m.name?.trim()) errors.push("`name` is required");
  if (!m.description?.trim()) errors.push("`description` is required");
  if (!m.version || !SEMVER_RE.test(m.version)) errors.push("`version` must be semver, e.g. 1.0.0");
  if (!m.author?.trim()) errors.push("`author` is required");

  if (!Array.isArray(m.commands) || m.commands.length === 0) {
    errors.push("`commands` must list at least one command");
  } else {
    const seen = new Set<string>();
    for (const [i, c] of m.commands.entries()) {
      if (!c.name || !ID_RE.test(c.name)) errors.push(`commands[${i}].name must be kebab-case`);
      else if (seen.has(c.name)) errors.push(`duplicate command name '${c.name}'`);
      else seen.add(c.name);
      if (!c.title?.trim()) errors.push(`commands[${i}].title is required`);
    }
  }

  const caps = m.capabilities;
  if (caps) {
    for (const key of REASON_REQUIRED) {
      const cap = caps[key] as { reason?: string } | undefined;
      if (cap && !cap.reason?.trim()) {
        errors.push(
          `capabilities.${key} needs a \`reason\` — it is shown to the user verbatim when they approve the install`,
        );
      }
    }
    for (const [i, use] of (caps.services?.uses ?? []).entries()) {
      if (!use.reason?.trim()) errors.push(`capabilities.services.uses[${i}] needs a \`reason\``);
      if (!use.extension || !use.service) {
        errors.push(`capabilities.services.uses[${i}] needs both \`extension\` and \`service\``);
      }
    }
    if (caps.network?.domains?.includes("*")) {
      // Allowed, but it is a runtime-consent tier rather than install-time.
      // Surfaced so authors know it changes the install experience.
      errors.push(
        "capabilities.network.domains contains '*' — wildcard network is a runtime-prompt tier and will prompt the user on every new host",
      );
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, manifest: m as ExtensionManifest };
}

/** Capability list for consent UI and update diffs. Stable ordering so a diff
 *  between two versions is meaningful rather than order-dependent. */
export function describeCapabilities(caps: Capabilities | undefined): {
  key: string;
  label: string;
  detail: string;
  reason: string;
  tier: "install" | "runtime";
}[] {
  if (!caps) return [];
  const out: ReturnType<typeof describeCapabilities> = [];

  if (caps.workspace) {
    const w = caps.workspace;
    if (w.read?.length) {
      out.push({
        key: "workspace.read",
        label: "Read notes",
        detail: w.read.join(", "),
        reason: w.reason,
        tier: "install",
      });
    }
    if (w.write?.length) {
      out.push({
        key: "workspace.write",
        label: "Modify notes",
        detail: w.write.join(", "),
        reason: w.reason,
        tier: "runtime",
      });
    }
    if (w.delete?.length) {
      out.push({
        key: "workspace.delete",
        label: "Delete notes",
        detail: w.delete.join(", "),
        reason: w.reason,
        tier: "runtime",
      });
    }
  }

  if (caps.network) {
    const domains = caps.network.domains ?? [];
    if (domains.length) {
      const wildcard = domains.includes("*");
      out.push({
        key: "network",
        label: wildcard ? "Access any website" : "Access specific websites",
        detail: domains.join(", "),
        reason: caps.network.reason,
        tier: wildcard ? "runtime" : "install",
      });
    }
  }

  if (caps.ai) {
    out.push({
      key: "ai",
      label: "Send text to GitHub Copilot",
      detail: "Content you pass to the model leaves this machine",
      reason: caps.ai.reason,
      tier: "install",
    });
  }

  if (caps.embeddings) {
    out.push({
      key: "embeddings",
      label: caps.embeddings.write ? "Build and search the note index" : "Search the note index",
      detail: "Runs on-device; nothing is uploaded",
      reason: caps.embeddings.reason,
      tier: "install",
    });
  }

  if (caps.clipboard) {
    if (caps.clipboard.read) {
      out.push({
        key: "clipboard.read",
        label: "Read the clipboard",
        detail: "",
        reason: caps.clipboard.reason,
        tier: "install",
      });
    }
    if (caps.clipboard.write) {
      out.push({
        key: "clipboard.write",
        label: "Write to the clipboard",
        detail: "",
        reason: caps.clipboard.reason,
        tier: "install",
      });
    }
  }

  for (const use of caps.services?.uses ?? []) {
    out.push({
      key: `services.${use.extension}.${use.service}`,
      label: `Use "${use.service}" from ${use.extension}`,
      detail: "",
      reason: use.reason,
      tier: "install",
    });
  }

  if (caps.storage?.shared?.length) {
    out.push({
      key: "storage.shared",
      label: "Share stored data with other extensions",
      detail: caps.storage.shared.join(", "),
      reason: caps.storage.reason ?? "",
      tier: "install",
    });
  }

  return out.sort((a, b) => a.key.localeCompare(b.key));
}
