/**
 * Driving an extension install from the frontend.
 *
 * Installation is deliberately two round trips to Rust, not one:
 *
 *   resolve  - fetch and inspect a release, write nothing, report what the
 *              user is being asked to approve
 *   commit   - install, but only when handed back the exact bundle hash
 *              `resolve` reported
 *
 * The hash echo is what makes the split worth having. If this module could
 * call `install(repo)` after showing a dialog, Rust would have no way to know
 * a dialog ever appeared, and a second fetch could return a different release
 * than the one whose permissions the user read. Requiring the hash means the
 * host installs the reviewed bytes or nothing at all.
 *
 * A staged download that is never committed or cancelled is held only in
 * memory on the Rust side, so abandoning a dialog - including by quitting -
 * leaves nothing on disk.
 */

import { invoke } from "@tauri-apps/api/core";

export type PermissionTier = "install" | "runtime" | "unsafe";

export interface PermissionDescription {
  key: string;
  label: string;
  detail: string;
  reason: string | null;
  tier: PermissionTier;
}

export interface InstallCandidate {
  repo: string;
  manifest: { id: string; name: string; author: string; version: string };
  permissions: PermissionDescription[];
  version: string;
  bundleSha256: string;
  /** `null` for a first install, otherwise the version being replaced. */
  replacesVersion: string | null;
  /** Capabilities this version wants that the installed one did not have. */
  addedCapabilities: string[];
  requiresUnsafe: boolean;
}

export function resolveInstall(repo: string): Promise<InstallCandidate> {
  return invoke<InstallCandidate>("extension_install_resolve", { repo });
}

export function commitInstall(candidate: InstallCandidate): Promise<void> {
  return invoke("extension_install_commit", { bundleSha256: candidate.bundleSha256 });
}

export function cancelInstall(candidate: InstallCandidate): Promise<void> {
  return invoke("extension_install_cancel", { bundleSha256: candidate.bundleSha256 });
}

export function uninstallExtension(extensionId: string): Promise<void> {
  return invoke("extension_uninstall", { extensionId });
}

/**
 * A GitHub token for private-repo installs.
 *
 * The token is written straight to the OS keychain and is never readable from
 * here again - `hasToken` reports only whether one exists. Keeping the secret
 * out of the WebView matters because this is the same WebView that renders
 * extension UI code.
 */
export function saveToken(token: string): Promise<void> {
  return invoke("extension_token_save", { token });
}

export function clearToken(): Promise<void> {
  return invoke("extension_token_clear");
}

export function hasToken(): Promise<boolean> {
  return invoke<boolean>("extension_token_status");
}

/**
 * Whether an update can be applied without asking again.
 *
 * A version bump that requests no new capability is a maintenance update and
 * interrupting for it trains users to click through consent dialogs without
 * reading them. One that requests something new is not an update at all - it
 * is a fresh trust decision, and it must stop.
 *
 * Kept as a pure function so the rule is testable without a dialog, a network
 * call, or a Tauri host.
 */
export function needsConsent(candidate: InstallCandidate): boolean {
  if (candidate.replacesVersion == null) return true;
  return candidate.addedCapabilities.length > 0;
}

/** One installed extension with a newer release available. */
export interface AvailableUpdate {
  id: string;
  repo: string;
  installedVersion: string;
  latestVersion: string;
}

/** An extension that could not be checked, and why. */
export interface UpdateCheckError {
  id: string;
  message: string;
}

export interface UpdateReport {
  available: AvailableUpdate[];
  /**
   * Reported separately from `available` so the UI can say an extension could
   * not be checked. Folding a failure into "no updates" makes a revoked token
   * look exactly like being up to date.
   */
  errors: UpdateCheckError[];
}

/**
 * Ask GitHub whether any installed extension has a newer release.
 *
 * Reports only. Installing an update still goes through {@link resolveInstall}
 * and {@link commitInstall}, so the permission diff is shown as it would be for
 * any other install.
 */
export function checkForUpdates(): Promise<UpdateReport> {
  return invoke<UpdateReport>("extension_check_updates");
}

/** An entry in the official registry. */
export interface RegistryEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  /** `owner/repo` - everything authoritative is fetched from here. */
  repo: string;
}

/**
 * Fetch the official extension list.
 *
 * A lookup table only: installing from here uses the identical code path and
 * the identical consent dialog as typing `owner/repo` by hand.
 */
export function listOfficialExtensions(): Promise<RegistryEntry[]> {
  return invoke<RegistryEntry[]>("extension_registry_list");
}

/** What an update check should be reported as. */
export type UpdateSummary =
  | { kind: "not-checked" }
  | { kind: "up-to-date" }
  | { kind: "updates"; count: number }
  | { kind: "partial"; count: number; failed: number };

/**
 * Decide what to tell the user after an update check.
 *
 * Extracted from the component because the interesting case is easy to get
 * wrong by accident: if any extension could *not* be checked, the answer is
 * never "everything is up to date". A revoked token, a renamed repo, or an
 * offline machine would otherwise be indistinguishable from being current,
 * and the user would sit on a stale version believing they were not.
 */
export function summarizeUpdates(report: UpdateReport | null): UpdateSummary {
  if (!report) return { kind: "not-checked" };

  const count = report.available.length;
  const failed = report.errors.length;

  if (failed > 0) return { kind: "partial", count, failed };
  if (count > 0) return { kind: "updates", count };
  return { kind: "up-to-date" };
}
