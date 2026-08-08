/**
 * The extension commands a user can open from the command palette.
 *
 * Reads manifests rather than starting anything: listing what is installed must
 * not cost a VM. The runtime is only built when a panel actually opens.
 *
 * `no-view` commands are excluded. They have no panel to show, so offering them
 * here would give the user a menu entry that appears to do nothing.
 */

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ExtensionCommandEntry {
  /** `extensionId:command`, the panel id understood by the dock. */
  panelId: string;
  extensionName: string;
  title: string;
}

interface ManifestSummary {
  id: string;
  name: string;
  commands: { name: string; title: string; mode: "view" | "no-view" }[];
}

export function useExtensionCommands(): ExtensionCommandEntry[] {
  const [entries, setEntries] = useState<ExtensionCommandEntry[]>([]);

  useEffect(() => {
    let cancelled = false;

    invoke<ManifestSummary[]>("extension_list")
      .then((manifests) => {
        if (cancelled) return;
        setEntries(
          manifests.flatMap((manifest) =>
            (manifest.commands ?? [])
              .filter((command) => command.mode === "view")
              .map((command) => ({
                panelId: `${manifest.id}:${command.name}`,
                extensionName: manifest.name,
                title: command.title,
              })),
          ),
        );
      })
      .catch((err: unknown) => {
        // Not fatal: the palette still works, it just has no extension
        // entries. Logged rather than swallowed so a registry that failed to
        // load does not present as "you have no extensions".
        console.error("[extensions] could not list commands", err);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return entries;
}
