/**
 * The decisions a user has made about one extension's runtime permissions, and
 * a way to take them back.
 *
 * This exists because a permission granted once and then never mentioned again
 * is one the user has lost control of. The prompt is a good moment to decide
 * and a bad moment to reconsider: it appears while something else is happening,
 * and "always" is chosen partly to stop being asked. Without this list, that
 * choice would be permanent in practice.
 *
 * Only decisions that were actually recorded appear. An extension the user has
 * never been asked about renders nothing at all rather than an empty heading,
 * because a "Permissions" label with nothing under it reads as a missing
 * feature.
 */

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface GrantRecord {
  key: string;
  /** Writer's wording, falling back to the raw key. */
  label: string;
  allowed: boolean;
}

export function ExtensionGrants({ extensionId }: { extensionId: string }) {
  const [grants, setGrants] = useState<GrantRecord[]>([]);

  const load = useCallback(async () => {
    try {
      setGrants(await invoke<GrantRecord[]>("extension_grants", { extensionId }));
    } catch {
      // A listing that cannot be read must not take the Extensions pane down
      // with it; uninstall and update have to stay reachable.
      setGrants([]);
    }
  }, [extensionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = useCallback(
    async (key: string) => {
      await invoke("extension_grant_revoke", { extensionId, key });
      // Re-read rather than filtering locally, so the list shows what Rust
      // actually holds. Rust is the authority on these decisions and the UI
      // should not narrate a state it did not confirm.
      await load();
    },
    [extensionId, load],
  );

  if (grants.length === 0) return null;

  return (
    <div className="mt-2">
      <p className="text-[12px] text-[var(--text-muted)]">Remembered decisions</p>
      <ul className="mt-1 space-y-1">
        {grants.map((grant) => (
          <li key={grant.key} className="flex items-center gap-2">
            <span className="text-[12px] text-[var(--text-muted)]">
              {grant.allowed ? "Allowed" : "Refused"}: {grant.label}
            </span>
            <button
              type="button"
              className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:underline"
              onClick={() => void revoke(grant.key)}
            >
              Ask again
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
