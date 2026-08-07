/**
 * Transient feedback. These are host-rendered chrome, not part of the
 * extension's UI tree, so they work from `no-view` commands too.
 */

import { bridge } from "./runtime/bridge";

export interface ToastOptions {
  style?: "success" | "failure" | "animated";
  title: string;
  message?: string;
}

export function showToast(options: ToastOptions): void {
  bridge.toast(options.style ?? "success", options.title, options.message);
}

/** Brief, non-blocking confirmation. Maps to a toast without a body. */
export function showHUD(title: string): void {
  bridge.toast("success", title);
}

export interface AlertOptions {
  title: string;
  message?: string;
  primaryTitle?: string;
  cancelTitle?: string;
  destructive?: boolean;
}

/** Modal confirmation rendered by the host. Resolves true if confirmed. */
export function confirmAlert(options: AlertOptions): Promise<boolean> {
  return bridge.invoke("ui", "confirm", [
    {
      title: options.title,
      message: options.message ?? null,
      primaryTitle: options.primaryTitle ?? "Confirm",
      cancelTitle: options.cancelTitle ?? "Cancel",
      destructive: options.destructive ?? false,
    },
  ]);
}

/** Open a note in the editor. A built-in host action, so it needs no grant. */
export function openNote(path: string): Promise<void> {
  return bridge.invoke("ui", "openNote", [path]);
}

export function closeCommand(): Promise<void> {
  return bridge.invoke("ui", "close", []);
}
