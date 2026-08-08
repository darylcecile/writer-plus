/**
 * End-to-end proof that the architecture actually works.
 *
 * This is the test that matters most: it bundles React 19, the guest
 * reconciler and a sample extension exactly as the real build pipeline will,
 * evaluates the bundle inside a real QuickJS VM, and asserts a usable UI tree
 * comes back out. The unit tests pin individual behaviours; only this one
 * proves the pieces compose.
 *
 * The bundle is produced at test time rather than checked in, so the test
 * fails if the guest runtime stops being bundleable for the VM (for example by
 * acquiring a Node or DOM dependency).
 */

import { describe, expect, it, beforeAll } from "vitest";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { build } from "esbuild";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionVm, type VmCallbacks } from "../src/vm";
import type { HostTree } from "@writer/extension-api/protocol";

const here = fileURLToPath(new URL(".", import.meta.url));
const apiSrc = join(here, "..", "..", "extension-api", "src");

let wasm: QuickJSWASMModule;
let bundle: string;

/** The sample extension, written the way a real extension author would. */
const EXTENSION_SOURCE = `
import { useState, useEffect } from "react";
import { List, Detail, ActionPanel, Action } from "${apiSrc}/components/index";
import { guest } from "${apiSrc}/runtime/index";

function Notes({ greeting }) {
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);

  // Exercises the effect -> setState -> re-render path, which is exactly what
  // silently failed until the scheduler globals were injected.
  useEffect(() => { setReady(true); }, []);

  const items = ["alpha", "beta", "gamma"].filter((n) => n.startsWith(query));

  return (
    <List isLoading={!ready} searchBarPlaceholder={greeting} onSearchTextChange={setQuery}>
      {items.map((name) => (
        <List.Item
          key={name}
          title={name}
          subtitle={ready ? "ready" : "loading"}
          actions={<ActionPanel><Action title={"Open " + name} onAction={() => setQuery(name)} /></ActionPanel>}
        />
      ))}
    </List>
  );
}

function Info() {
  return <Detail markdown="# Hello" />;
}

guest.register({ commands: { notes: Notes, info: Info } });
`;

beforeAll(async () => {
  wasm = await newQuickJSWASMModuleFromVariant(releaseSync);

  // Written inside the api package so `react` resolves through the normal
  // workspace node_modules, exactly as a real extension build would.
  const dir = await mkdtemp(join(apiSrc, "..", ".e2e-"));
  const entry = join(dir, "entry.jsx");
  const out = join(dir, "bundle.js");
  await writeFile(entry, EXTENSION_SOURCE, "utf8");

  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: out,
    // QuickJS has no module loader and no DOM, so the bundle must be a single
    // self-contained IIFE targeting a plain ES2020 engine.
    format: "iife",
    platform: "neutral",
    target: "es2020",
    jsx: "automatic",
    // React ships separate dev/prod builds behind this condition; without it
    // the bundle keeps dev-only warning paths that pull in extra globals.
    define: { "process.env.NODE_ENV": '"production"' },
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    logLevel: "silent",
  });

  bundle = await readFile(out, "utf8");
  await rm(dir, { recursive: true, force: true });
}, 120_000);

function harness() {
  const commits: HostTree[] = [];
  const logs: { level: string; message: string }[] = [];
  const errors: string[] = [];

  const callbacks: VmCallbacks = {
    onCommit: (tree) => commits.push(tree),
    onLog: (level, message) => {
      logs.push({ level, message });
      if (level === "error") errors.push(message);
    },
    onCapability: () => {},
    onToast: () => {},
  };

  const vm = new ExtensionVm(wasm, callbacks, { memoryBytes: 128 * 1024 * 1024, budgetMs: 10_000 });
  return { vm, commits, logs, errors };
}

const latest = (commits: HostTree[]) => commits[commits.length - 1];

describe("extension end-to-end in QuickJS", () => {
  it("bundles without pulling in Node or DOM dependencies", () => {
    expect(bundle.length).toBeGreaterThan(1000);
    // A bundle that reaches for these cannot run in the VM at all.
    expect(bundle).not.toMatch(/\brequire\("(fs|path|module)"\)/);
    expect(bundle).not.toMatch(/\bdocument\.createElement\b/);
  });

  it("mounts a React component and commits a renderable tree", () => {
    const { vm, commits, errors } = harness();
    try {
      vm.evaluate(bundle);
      vm.callGuest("mount", ["notes", JSON.stringify({ greeting: "Search notes" })]);
      vm.runTimers();

      expect(errors).toEqual([]);
      const tree = latest(commits);
      expect(tree).toBeDefined();

      const list = tree.root[0];
      expect(list.type).toBe("List");
      expect(list.props.searchBarPlaceholder).toBe("Search notes");
      expect(list.children.map((c) => c.props.title)).toEqual(["alpha", "beta", "gamma"]);

      // The effect ran and its setState re-rendered: isLoading flipped and the
      // subtitle changed. This is the path that fails silently without the
      // injected scheduler globals.
      expect(list.props.isLoading).toBe(false);
      expect(list.children[0].props.subtitle).toBe("ready");
    } finally {
      vm.dispose();
    }
  });

  it("routes an event back into the VM and re-renders", () => {
    const { vm, commits, errors } = harness();
    try {
      vm.evaluate(bundle);
      vm.callGuest("mount", ["notes", JSON.stringify({ greeting: "Search" })]);
      vm.runTimers();

      const handlerId = latest(commits).root[0].handlers.onSearchTextChange;
      expect(handlerId, "List must expose its onSearchTextChange handler").toBeTruthy();

      vm.callGuest("event", [handlerId, JSON.stringify(["b"])]);
      vm.runTimers();

      expect(errors).toEqual([]);
      expect(latest(commits).root[0].children.map((c) => c.props.title)).toEqual(["beta"]);
    } finally {
      vm.dispose();
    }
  });

  it("invokes a nested action handler", () => {
    const { vm, commits, errors } = harness();
    try {
      vm.evaluate(bundle);
      vm.callGuest("mount", ["notes", JSON.stringify({ greeting: "Search" })]);
      vm.runTimers();

      // actions arrive as a prop-embedded subtree, so this also proves nested
      // element props survive the boundary with their handlers intact.
      const item = latest(commits).root[0].children[0];
      const panel = item.children.find((c) => c.type === "ActionPanel");
      expect(panel, "ActionPanel must reach the host").toBeDefined();
      const action = panel!.children[0];
      expect(action.type).toBe("Action");
      expect(action.props.title).toBe("Open alpha");

      vm.callGuest("event", [action.handlers.onAction, JSON.stringify([])]);
      vm.runTimers();

      expect(errors).toEqual([]);
      expect(latest(commits).root[0].children.map((c) => c.props.title)).toEqual(["alpha"]);
    } finally {
      vm.dispose();
    }
  });

  it("reports an unknown command instead of failing silently", () => {
    const { vm } = harness();
    try {
      vm.evaluate(bundle);
      expect(() => vm.callGuest("mount", ["nope", "{}"])).toThrow(/unknown command/);
    } finally {
      vm.dispose();
    }
  });

  it("renders a second command in the same VM", () => {
    const { vm, commits, errors } = harness();
    try {
      vm.evaluate(bundle);
      vm.callGuest("mount", ["info", "{}"]);
      vm.runTimers();
      expect(errors).toEqual([]);
      expect(latest(commits).root[0].type).toBe("Detail");
      expect(latest(commits).root[0].props.markdown).toBe("# Hello");
    } finally {
      vm.dispose();
    }
  });

  it("disposes cleanly with React loaded", () => {
    const { vm } = harness();
    vm.evaluate(bundle);
    vm.callGuest("mount", ["notes", JSON.stringify({ greeting: "x" })]);
    vm.runTimers();
    vm.callGuest("dispose", []);
    // React allocates a lot of handles; a leak aborts the WASM module here.
    expect(() => vm.dispose()).not.toThrow();
  });
});
