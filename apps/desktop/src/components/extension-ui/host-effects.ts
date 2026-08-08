/**
 * Effects the host performs on an extension's behalf.
 *
 * Every one of these does something the extension could not do itself: open a
 * note, reach the clipboard, launch a browser. They are ungated on purpose -
 * requiring `workspace.read` just to offer an "Open Note" menu item would push
 * extensions to ask for far more than they need, and a permission users are
 * trained to grant reflexively protects nobody.
 *
 * What makes that safe is that the extension gains nothing observable. It never
 * receives the file, the clipboard, or a result; it cannot even tell whether
 * the effect happened. So the only thing to defend is the host itself being
 * pointed somewhere it should not go, which is what the containment call and
 * the scheme check below are for.
 */

import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useMemo } from "react";
import { useEditorStore } from "@/stores/editor-store";
import type { HostEffects } from "./renderers";

/**
 * Schemes an extension may ask the host to launch.
 *
 * Anything else is refused. `file:` would open arbitrary local paths in
 * whatever application claims them, and on macOS custom schemes reach any
 * registered app - so an unrestricted opener is a way to launch software with
 * attacker-chosen arguments from inside a sandbox that exists to prevent
 * exactly that.
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function isSafeExternalUrl(url: string): boolean {
  try {
    return SAFE_SCHEMES.has(new URL(url).protocol);
  } catch {
    // Unparseable is not openable. A relative or malformed string would be
    // resolved by someone downstream, and that someone is not the host.
    return false;
  }
}

export interface PanelNavigation {
  push: HostEffects["push"];
  pop: HostEffects["pop"];
}

/**
 * Builds the effect set for one extension.
 *
 * `extensionId` is not decoration: it is what lets Rust refuse a path for a
 * disabled or uninstalled extension, and it keeps the resolve call from
 * becoming a general-purpose path oracle for anything running in the WebView.
 */
export function useHostEffects(extensionId: string, navigation: PanelNavigation): HostEffects {
  return useMemo<HostEffects>(
    () => ({
      openNote: (path) => {
        if (!path) return;
        void (async () => {
          try {
            const resolved = await invoke<string>("extension_resolve_note", {
              extensionId,
              path,
            });
            await useEditorStore.getState().openFile(resolved);
          } catch (error) {
            // Logged rather than surfaced: the extension must not learn whether
            // the path existed, and the user asked to open a note, not to hear
            // about an extension's bad path.
            console.warn(`[extensions] ${extensionId} could not open ${path}`, error);
          }
        })();
      },

      copyToClipboard: (text) => {
        void writeText(text).catch((error) => {
          console.warn(`[extensions] ${extensionId} could not write the clipboard`, error);
        });
      },

      openInBrowser: (url) => {
        if (!isSafeExternalUrl(url)) {
          console.warn(`[extensions] ${extensionId} tried to open an unsupported URL: ${url}`);
          return;
        }
        void openUrl(url).catch((error) => {
          console.warn(`[extensions] ${extensionId} could not open ${url}`, error);
        });
      },

      push: navigation.push,
      pop: navigation.pop,
    }),
    [extensionId, navigation],
  );
}
