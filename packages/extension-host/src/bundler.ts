/**
 * Bundles an extension's TypeScript source into a single script the VM can
 * evaluate.
 *
 * This lives in the host package rather than in each extension so there is
 * exactly one bundle configuration. The settings below are not stylistic -
 * each one is required for the output to run inside QuickJS:
 *
 * - `format: "iife"` because the VM has no module loader. An ESM or CJS
 *   bundle would reference `import`/`require` and fail at evaluation.
 * - `platform: "neutral"` so esbuild never substitutes a Node or browser
 *   shim. A Node shim would reference `process`/`Buffer`, which do not exist
 *   in the VM.
 * - `jsxImportSource` pointed at the API package so the extension and the
 *   guest runtime share one React instance. Two Reacts would each get their
 *   own reconciler and neither would see the other's tree.
 * - `NODE_ENV=production` to drop React's development-only warning paths,
 *   which are a large share of the bundle and pull in `console` formatting
 *   the VM does not need.
 */

import { build } from "esbuild";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Root of `@writer/extension-api`, used to pin the JSX runtime. */
function apiRoot(): string {
  return join(HERE, "..", "..", "extension-api");
}

/**
 * Directory esbuild appends `/jsx-runtime` to.
 *
 * This must point at `src`, not the package root: the root has no
 * `jsx-runtime` file, only a `package.json` `exports` entry mapping the
 * subpath to `src/jsx-runtime.ts`, and esbuild does not apply an exports map
 * to an absolute path. Both spellings land on the same module, so pinning the
 * on-disk one keeps a single React without changing what gets loaded.
 */
function jsxRuntimeSource(): string {
  return join(apiRoot(), "src");
}

export interface BundleOptions {
  /** Absolute path to the extension's entry module. */
  entryPoint: string;
  /** Directory to place intermediate files in. Defaults to the entry's dir. */
  scratchDir?: string;
}

/**
 * Build one extension and return its source as a string.
 *
 * The entry is wrapped rather than compiled directly: an extension default
 * exports its command map, but the VM needs a script that *registers* it with
 * the guest runtime. Generating the wrapper here keeps that contract out of
 * every extension's source. Absolute specifiers are used so the generated
 * entry can live in a scratch directory without relative-path bookkeeping.
 */
export async function bundleExtension(options: BundleOptions): Promise<string> {
  const scratchRoot = options.scratchDir ?? dirname(options.entryPoint);
  const dir = await mkdtemp(join(scratchRoot, ".ext-build-"));
  const entry = join(dir, "entry.jsx");
  const out = join(dir, "bundle.js");

  const runtime = join(apiRoot(), "src", "runtime", "index");
  await writeFile(
    entry,
    `import mod from ${JSON.stringify(options.entryPoint)};\n` +
      `import { guest } from ${JSON.stringify(runtime)};\n` +
      `guest.register(mod);\n`,
    "utf8",
  );

  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      outfile: out,
      format: "iife",
      platform: "neutral",
      target: "es2020",
      jsx: "automatic",
      jsxImportSource: jsxRuntimeSource(),
      define: { "process.env.NODE_ENV": '"production"' },
      mainFields: ["module", "main"],
      conditions: ["import", "default"],
      logLevel: "silent",
    });
    return await readFile(out, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
