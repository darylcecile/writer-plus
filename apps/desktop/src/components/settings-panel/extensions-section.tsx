/**
 * The Extensions section of Preferences.
 *
 * This is the entry point that makes the whole permission model reachable.
 * The Rust gate, the manifest schema, and the `unsafe` tier are all inert
 * until a user can install something and be asked - so an install surface that
 * nothing renders is not a smaller version of this feature, it is none of it.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { InstallExtension } from "@/components/extension-ui/install-extension";
import { uninstallExtension } from "@/components/extension-ui/install";

interface InstalledManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
}

export function ExtensionsSection() {
  const [installed, setInstalled] = useState<InstalledManifest[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInstalled(await invoke<InstalledManifest[]>("extension_list"));
      setError(null);
    } catch (err) {
      // A failure to list is worth showing rather than rendering an empty
      // list, which would read as "you have no extensions".
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await uninstallExtension(id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  return (
    <section className="mb-10">
      <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">Extensions</h2>

      <div className="-mx-4 mb-4 overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        {installed.length === 0 ? (
          <p className="px-4 py-4 text-[13px] text-[var(--text-muted)]">
            No extensions installed yet.
          </p>
        ) : (
          installed.map((extension, i) => (
            <div
              key={extension.id}
              className={`flex items-start justify-between gap-4 px-4 py-3 ${
                i === 0 ? "" : "border-t border-[var(--line-subtler)]"
              }`}
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-[var(--text-primary)]">
                  {extension.name}{" "}
                  <span className="font-normal text-[var(--text-muted)]">v{extension.version}</span>
                </p>
                <p className="text-[12px] text-[var(--text-muted)]">{extension.description}</p>
              </div>
              <button
                type="button"
                className="shrink-0 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                onClick={() => void remove(extension.id)}
              >
                Uninstall
              </button>
            </div>
          ))
        )}
      </div>

      {error && <p className="mb-3 text-[12px] text-[#d9534f]">{error}</p>}

      <InstallExtension onInstalled={() => void refresh()} />
    </section>
  );
}
