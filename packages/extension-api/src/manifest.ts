/**
 * Manifest types for extension authors.
 *
 * **Rust owns the manifest schema.** `apps/desktop/src-tauri/src/extensions/manifest.rs`
 * is what actually parses, validates, and enforces a manifest, and it also
 * derives the wording shown in the install consent dialog. These types exist
 * only to give authors editor completion while writing `manifest.json`.
 *
 * This file used to carry a second, hand-written copy of the capability schema
 * plus its own validator and consent-description function. The two copies
 * drifted: the TypeScript side modelled capabilities as an object keyed by
 * name, Rust as a tagged array, and the TypeScript validator rejected the
 * shipped `ai-chat` manifest outright. Worse, the consent dialog read the
 * TypeScript shape, so a real downloaded extension would have rendered an
 * install dialog listing no permissions at all. A permission model whose
 * consent surface silently shows nothing is worse than one with no dialog.
 *
 * So there is now one schema, in Rust, next to the code that enforces it.
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
  /**
   * Declared as `permissions` in `manifest.json`. Not modelled here: the
   * authoritative shape is the `CapabilityGrant` enum in Rust, and a second
   * copy of it in TypeScript is exactly what drifted before.
   */
  permissions?: unknown;
}
