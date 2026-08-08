/**
 * The Extensions section of Preferences.
 *
 * This is the entry point that makes the whole permission model reachable.
 * The Rust gate, the manifest schema, and the `unsafe` tier are all inert
 * until a user can install something and be asked - so an install surface that
 * nothing renders is not a smaller version of this feature, it is none of it.
 *
 * Official extensions, updates, and hand-typed repositories all funnel into the
 * same `InstallExtension` state machine. Being listed officially is a
 * convenience, not a privilege: it skips no step of the consent flow.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InstallExtension } from "@/components/extension-ui/install-extension";
import {
  type RegistryEntry,
  type UpdateReport,
  checkForUpdates,
  listOfficialExtensions,
  summarizeUpdates,
  uninstallExtension,
} from "@/components/extension-ui/install";

interface InstalledManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
}

/** A repository the user asked to install, with a nonce so re-picking works. */
type InstallRequest = { repo: string; nonce: number } | null;

export function ExtensionsSection() {
  const [installed, setInstalled] = useState<InstalledManifest[]>([]);
  const [official, setOfficial] = useState<RegistryEntry[] | null>(null);
  const [updates, setUpdates] = useState<UpdateReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [request, setRequest] = useState<InstallRequest>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInstalled(await invoke<InstalledManifest[]>("extension_list"));
      setError(null);
    } catch (err) {
      // A failure to list is worth showing rather than rendering an empty
      // list, which would read as "you have no extensions".
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The official list is a nicety; failing to fetch it must not break the
    // section, so it just stays hidden.
    listOfficialExtensions()
      .then(setOfficial)
      .catch(() => setOfficial([]));
  }, [refresh]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await uninstallExtension(id);
        await refresh();
      } catch (err) {
        setError(messageOf(err));
      }
    },
    [refresh],
  );

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setUpdates(await checkForUpdates());
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setChecking(false);
    }
  }, []);

  const requestInstall = useCallback((repo: string) => {
    setRequest({ repo, nonce: Date.now() });
  }, []);

  const summary = summarizeUpdates(updates);
  const installedIds = new Set(installed.map((e) => e.id));
  const notInstalled = (official ?? []).filter((e) => !installedIds.has(e.id));

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">Extensions</h2>

      <div className="-mx-4 mb-4 overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        {installed.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-[var(--text-muted)]">
            No extensions installed yet.
          </p>
        ) : (
          installed.map((extension, i) => {
            const update = updates?.available.find((u) => u.id === extension.id);
            const failed = updates?.errors.find((e) => e.id === extension.id);
            return (
              <div
                key={extension.id}
                className={`flex items-start justify-between gap-4 px-4 py-3 ${
                  i === 0 ? "" : "border-t border-[var(--line-subtler)]"
                }`}
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[var(--text-primary)]">
                    {extension.name}{" "}
                    <span className="font-normal text-[var(--text-muted)]">
                      v{extension.version}
                    </span>
                  </p>
                  <p className="text-[12px] text-[var(--text-muted)]">{extension.description}</p>
                  {update && (
                    <p className="mt-1 text-[12px] text-[var(--text-primary)]">
                      Version {update.latestVersion} is available.
                    </p>
                  )}
                  {failed && (
                    // Reported rather than folded into "up to date": a revoked
                    // token and a current version must not look identical.
                    <p className="mt-1 text-[12px] text-[#d9534f]">
                      Could not check for updates: {failed.message}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-3">
                  {update && (
                    <button
                      type="button"
                      className="text-[12px] text-[var(--text-primary)] hover:underline"
                      onClick={() => requestInstall(update.repo)}
                    >
                      Update
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    onClick={() => void remove(extension.id)}
                  >
                    Uninstall
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {installed.length > 0 && (
        <div className="mb-4 flex items-center gap-3">
          <button
            type="button"
            disabled={checking}
            className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-50"
            onClick={() => void check()}
          >
            {checking ? "Checking\u2026" : "Check for updates"}
          </button>
          {summary.kind === "up-to-date" && (
            <span className="text-[12px] text-[var(--text-muted)]">Everything is up to date.</span>
          )}
          {summary.kind === "partial" && (
            <span className="text-[12px] text-[#d9534f]">
              {summary.failed} extension{summary.failed === 1 ? "" : "s"} could not be checked.
            </span>
          )}
        </div>
      )}

      {notInstalled.length > 0 && (
        <>
          <h3 className="mb-2 text-[12px] font-medium text-[var(--text-muted)]">
            From the Writer registry
          </h3>
          <div className="-mx-4 mb-4 overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
            {notInstalled.map((entry, i) => (
              <div
                key={entry.id}
                className={`flex items-start justify-between gap-4 px-4 py-3 ${
                  i === 0 ? "" : "border-t border-[var(--line-subtler)]"
                }`}
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-[var(--text-primary)]">{entry.name}</p>
                  <p className="text-[12px] text-[var(--text-muted)]">{entry.description}</p>
                </div>
                <button
                  type="button"
                  className="shrink-0 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                  onClick={() => requestInstall(entry.repo)}
                >
                  Install
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {error && <p className="mb-3 text-[12px] text-[#d9534f]">{error}</p>}

      <InstallExtension
        requestedRepo={request}
        onInstalled={() => {
          setRequest(null);
          setUpdates(null);
          void refresh();
        }}
      />
    </section>
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
