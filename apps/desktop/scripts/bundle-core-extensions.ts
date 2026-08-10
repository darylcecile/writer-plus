/**
 * Bundles the first-party extensions in `/extensions` into the shape the Rust
 * side seeds on first run.
 *
 * # Why this exists
 *
 * A core extension is TypeScript source until something turns it into the
 * single IIFE script the VM evaluates. That "something" used to be only the
 * test suite, so the extensions worked under `vitest` but were never present
 * in a shipped build: a fresh launch found an empty registry and had nothing
 * to open. This script is that missing build step. It runs before `vp dev` and
 * `vp build` (see `beforeDevCommand`/`beforeBuildCommand`), writing each bundle
 * where Tauri picks it up as a bundled resource. `extensions::seed` then copies
 * them into the user's extensions directory on startup.
 *
 * # What counts as a core extension
 *
 * Everything under `/extensions`. That directory is the single source of truth;
 * adding a folder there is all it takes to ship another built-in. No list to
 * keep in sync, so none can drift.
 *
 * Run with `node` directly - Node strips the types, so no `tsx`/`ts-node` is
 * needed. `bundleExtension` is imported by relative path because the host
 * package only exports its public runtime surface, not the bundler.
 */

import { readdir, mkdir, rm, writeFile, copyFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleExtension } from "../../../packages/extension-host/src/bundler.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/desktop/scripts` -> repo root. */
const REPO_ROOT = join(HERE, "..", "..", "..");
const SOURCE_DIR = join(REPO_ROOT, "extensions");
const OUTPUT_DIR = join(REPO_ROOT, "apps", "desktop", "src-tauri", "core-extensions");

async function coreExtensionDirs(): Promise<string[]> {
  const entries = await readdir(SOURCE_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function main(): Promise<void> {
  const dirs = await coreExtensionDirs();
  if (dirs.length === 0) {
    throw new Error(`no core extensions found under ${SOURCE_DIR}`);
  }

  // Start clean so a removed or renamed extension cannot linger in a shipped
  // build as a resource nobody references any more.
  await rm(OUTPUT_DIR, { recursive: true, force: true });

  for (const dir of dirs) {
    const sourceDir = join(SOURCE_DIR, dir);
    const manifestPath = join(sourceDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { id: string };
    if (!manifest.id) {
      throw new Error(`${manifestPath} has no id`);
    }

    const bundle = await bundleExtension({
      entryPoint: join(sourceDir, "src", "index.tsx"),
    });

    // The output directory is keyed by extension id, matching how the registry
    // names an installed extension on disk. The seeder can then line a shipped
    // bundle up against an installed one by directory name alone.
    const outDir = join(OUTPUT_DIR, manifest.id);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "extension.js"), bundle, "utf8");
    await copyFile(manifestPath, join(outDir, "manifest.json"));

    console.log(`[core-extensions] ${manifest.id}: ${(bundle.length / 1024).toFixed(1)} KiB`);
  }
}

main().catch((err: unknown) => {
  console.error("[core-extensions] bundling failed:", err);
  process.exit(1);
});
