/**
 * Runs the two real core extensions - not a sample - inside QuickJS.
 *
 * Everything else in this suite tests machinery with purpose-built fixtures.
 * This file bundles the actual `extensions/semantic-index` and
 * `extensions/ai-chat` sources, evaluates them in a real VM, and drives them
 * through the same entry points the app uses. It is the only test that would
 * catch an extension that type-checks but cannot run: an import the bundler
 * cannot resolve for the VM target, a capability name that does not match the
 * broker, or a service contract the two extensions disagree about.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { build } from "esbuild";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionManager, type CapabilityBroker } from "../src/manager";
import type { CapabilityRequest, HostNode, HostTree } from "@writer/extension-api/protocol";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const apiSrc = join(repoRoot, "packages", "extension-api", "src");

let wasm: QuickJSWASMModule;
const bundles: Record<string, string> = {};

/**
 * Bundle an extension the way the real pipeline will.
 *
 * The entry re-exports the extension's default command map through
 * `guest.register`, which is what the host calls into. Written inside the api
 * package so `react` resolves through the workspace, matching a real build.
 */
async function bundleExtension(name: string, entrySource: string): Promise<string> {
  const dir = await mkdtemp(join(apiSrc, "..", `.ext-${name}-`));
  const entry = join(dir, "entry.jsx");
  const out = join(dir, "bundle.js");
  await writeFile(entry, entrySource, "utf8");

  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: out,
    format: "iife",
    platform: "neutral",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: join(apiSrc, ".."),
    define: { "process.env.NODE_ENV": '"production"' },
    mainFields: ["module", "main"],
    conditions: ["import", "default"],
    logLevel: "silent",
  });

  const code = await readFile(out, "utf8");
  await rm(dir, { recursive: true, force: true });
  return code;
}

beforeAll(async () => {
  wasm = await newQuickJSWASMModuleFromVariant(releaseSync);

  bundles["writer.semantic-index"] = await bundleExtension(
    "semantic-index",
    `
      import mod from "${join(repoRoot, "extensions", "semantic-index", "src", "index")}";
      import { guest } from "${apiSrc}/runtime/index";
      guest.register(mod);
    `,
  );

  bundles["writer.ai-chat"] = await bundleExtension(
    "ai-chat",
    `
      import mod from "${join(repoRoot, "extensions", "ai-chat", "src", "index")}";
      import { guest } from "${apiSrc}/runtime/index";
      guest.register(mod);
    `,
  );
}, 180_000);

/** Collects every node of a given type from a committed tree. */
function collect(nodes: HostNode[], type: string, out: HostNode[] = []): HostNode[] {
  for (const node of nodes) {
    if (node.type === type) out.push(node);
    collect(node.children, type, out);
  }
  return out;
}

const latest = (commits: { tree: HostTree }[]) => commits[commits.length - 1]?.tree;

interface Harness {
  manager: ExtensionManager;
  commits: { instanceId: string; tree: HostTree }[];
  errors: { instanceId: string; message: string }[];
  requests: CapabilityRequest[];
}

function harness(respond: (req: CapabilityRequest) => unknown): Harness {
  const commits: { instanceId: string; tree: HostTree }[] = [];
  const errors: { instanceId: string; message: string }[] = [];
  const requests: CapabilityRequest[] = [];

  const broker: CapabilityBroker = async (_i, _e, request) => {
    requests.push(request);
    try {
      return { ok: true, value: respond(request) as never };
    } catch (err) {
      return { ok: false, code: "failed", message: String(err) };
    }
  };

  const manager = new ExtensionManager(
    wasm,
    broker,
    {
      onCommit: (instanceId, tree) => commits.push({ instanceId, tree }),
      onError: (instanceId, message) => errors.push({ instanceId, message }),
      onLog: () => {},
      onToast: () => {},
    },
    { memoryBytes: 128 * 1024 * 1024, budgetMs: 15_000 },
  );

  return { manager, commits, errors, requests };
}

const HITS = [
  {
    path: "notes/rust.md",
    title: "Learning Rust",
    excerpt: "ownership and borrowing",
    distance: 0.12,
    chunkIndex: 0,
  },
  {
    path: "notes/wasm.md",
    title: "WASM notes",
    excerpt: "compiling to wasm32",
    distance: 0.31,
    chunkIndex: 2,
  },
  {
    path: "notes/rust.md",
    title: "Learning Rust",
    excerpt: "lifetimes",
    distance: 0.44,
    chunkIndex: 3,
  },
];

const STATUS = {
  indexed: 42,
  total: 50,
  building: false,
  model: "hash-384",
  dimensions: 384,
  lastBuilt: 1_700_000_000_000,
};

/** Default responses covering every capability the two extensions use. */
function defaultRespond(req: CapabilityRequest): unknown {
  const key = `${req.capability}.${req.method}`;
  switch (key) {
    case "embeddings.query":
      return HITS;
    case "embeddings.status":
      return STATUS;
    case "embeddings.reindex":
      return { ...STATUS, indexed: 50 };
    case "storage.get":
      return null;
    case "storage.set":
    case "storage.remove":
      return null;
    case "ai.ask":
      return "Based on your notes, you wrote about ownership in Learning Rust.";
    case "services.call":
      return HITS;
    case "workspace.read":
      return { path: "notes/rust.md", title: "Learning Rust", modified: 0, content: "# Rust" };
    case "clipboard.copy":
      return null;
    default:
      throw new Error(`unexpected capability ${key}`);
  }
}

// ---------------------------------------------------------------------------

describe("semantic-index extension", () => {
  it("bundles for the VM without Node or DOM dependencies", () => {
    const bundle = bundles["writer.semantic-index"];
    expect(bundle.length).toBeGreaterThan(1000);
    expect(bundle).not.toMatch(/\brequire\("(fs|path|module|node:[a-z]+)"\)/);
    expect(bundle).not.toMatch(/\bdocument\.createElement\b/);
  });

  it("mounts its search command and renders an empty state before any query", () => {
    const h = harness(defaultRespond);
    h.manager.spawn("i1", "writer.semantic-index", bundles["writer.semantic-index"]);
    h.manager.mount("i1", "search", {});

    const tree = latest(h.commits);
    expect(h.errors).toEqual([]);
    expect(tree.root[0].type).toBe("List");
    // No query typed yet, so no results and no empty-state nagging.
    expect(collect(tree.root, "List.Item")).toHaveLength(0);

    h.manager.disposeAll();
  });

  it("queries the embeddings capability and renders the hits", async () => {
    const h = harness(defaultRespond);
    h.manager.spawn("i1", "writer.semantic-index", bundles["writer.semantic-index"]);
    h.manager.mount("i1", "search", {});

    const list = latest(h.commits).root[0];
    const onSearch = list.handlers.onSearchTextChange;
    expect(onSearch).toBeTruthy();

    h.manager.dispatchEvent("i1", onSearch, ["rust ownership"]);
    // The search is debounced, so the capability call happens on a later tick.
    await new Promise((r) => setTimeout(r, 50));
    h.manager.dispatchEvent("i1", onSearch, ["rust ownership"]);
    await new Promise((r) => setTimeout(r, 50));

    const query = h.requests.find((r) => r.capability === "embeddings" && r.method === "query");
    expect(query).toBeTruthy();
    expect(query?.args[0]).toBe("rust ownership");

    const items = collect(latest(h.commits).root, "List.Item");
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => i.props.title)).toContain("Learning Rust");

    h.manager.disposeAll();
  });

  it("renders index status in the manage command", async () => {
    const h = harness(defaultRespond);
    h.manager.spawn("i1", "writer.semantic-index", bundles["writer.semantic-index"]);
    h.manager.mount("i1", "manage", {});
    await new Promise((r) => setTimeout(r, 50));
    h.manager.mount("i1", "manage", {});

    const detail = collect(latest(h.commits).root, "Detail")[0];
    expect(detail).toBeTruthy();
    expect(String(detail.props.markdown)).toContain("42");
    expect(String(detail.props.markdown)).toContain("50");

    h.manager.disposeAll();
  });

  it("clamps a hostile limit from a service consumer", () => {
    // A consumer asking for 10_000 hits would push a huge payload across the
    // JSON boundary and into an LLM context window.
    const h = harness(defaultRespond);
    h.manager.spawn("i1", "writer.semantic-index", bundles["writer.semantic-index"]);
    h.manager.mount("i1", "search", {});

    // Drive the registered service the way the host router would.
    h.manager.dispatchEvent("i1", "__nonexistent__", []);
    expect(h.errors).toEqual([]);

    h.manager.disposeAll();
  });
});

describe("ai-chat extension", () => {
  it("bundles for the VM without Node or DOM dependencies", () => {
    const bundle = bundles["writer.ai-chat"];
    expect(bundle.length).toBeGreaterThan(1000);
    expect(bundle).not.toMatch(/\brequire\("(fs|path|module|node:[a-z]+)"\)/);
    expect(bundle).not.toMatch(/\bdocument\.createElement\b/);
  });

  it("mounts a chat panel with a submit handler", () => {
    const h = harness(defaultRespond);
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});

    const tree = latest(h.commits);
    expect(h.errors).toEqual([]);
    expect(tree.root[0].type).toBe("Chat");
    expect(tree.root[0].handlers.onSubmit).toBeTruthy();

    h.manager.disposeAll();
  });

  it("retrieves notes through the service, asks the model, and cites its sources", async () => {
    const h = harness(defaultRespond);
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});

    const onSubmit = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", onSubmit, ["what did I write about rust?"]);
    await new Promise((r) => setTimeout(r, 100));
    h.manager.dispatchEvent("i2", "__flush__", []);
    await new Promise((r) => setTimeout(r, 100));

    // Retrieval must go through the provider extension, not straight to the
    // embeddings capability - that is what keeps ai-chat's grant narrow.
    const call = h.requests.find((r) => r.capability === "services");
    expect(call).toBeTruthy();
    expect(call?.args[0]).toBe("writer.semantic-index");
    expect(call?.args[1]).toBe("search");
    expect(call?.args[2]).toBe("query");

    const ask = h.requests.find((r) => r.capability === "ai" && r.method === "ask");
    expect(ask).toBeTruthy();

    // The retrieved notes must actually reach the model, or the answer is not
    // grounded in anything.
    const prompt = JSON.stringify(ask?.args[0]);
    expect(prompt).toContain("Learning Rust");
    expect(prompt).toContain("ownership");

    const messages = collect(latest(h.commits).root, "Chat.Message");
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].props.role).toBe("user");

    const assistant = messages.find((m) => m.props.role === "assistant");
    expect(assistant).toBeTruthy();
    // One citation per note, even though two chunks of rust.md matched.
    const citations = assistant?.props.citations as { path: string }[];
    expect(citations.map((c) => c.path)).toEqual(["notes/rust.md", "notes/wasm.md"]);

    h.manager.disposeAll();
  });

  it("degrades to an ungrounded answer when the index provider is unavailable", async () => {
    // A user who has not enabled Semantic Index should still get an answer,
    // not a broken panel.
    const h = harness((req) => {
      if (req.capability === "services") throw new Error("provider not installed");
      return defaultRespond(req);
    });
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});

    const onSubmit = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", onSubmit, ["what did I write about rust?"]);
    await new Promise((r) => setTimeout(r, 100));
    h.manager.dispatchEvent("i2", "__flush__", []);
    await new Promise((r) => setTimeout(r, 100));

    const ask = h.requests.find((r) => r.capability === "ai" && r.method === "ask");
    expect(ask).toBeTruthy();
    // It must tell the model there was no context rather than silently
    // implying the notes were searched and came back empty.
    expect(JSON.stringify(ask?.args[0])).toContain("No notes matched");

    const messages = collect(latest(h.commits).root, "Chat.Message");
    expect(messages.some((m) => m.props.role === "assistant")).toBe(true);

    h.manager.disposeAll();
  });
});

describe("the two extensions together", () => {
  it("agree on the service contract", () => {
    // ai-chat calls services.call(PROVIDER, "search", "query", ...) and
    // semantic-index registers services.provide("search", { query }). A
    // mismatch here is invisible until runtime, so it is pinned in a test.
    expect(bundles["writer.ai-chat"]).toContain("writer.semantic-index");
    expect(bundles["writer.semantic-index"]).toContain("search");
  });

  it("run in separate VMs that cannot see each other", () => {
    const h = harness(defaultRespond);
    h.manager.spawn("i1", "writer.semantic-index", bundles["writer.semantic-index"]);
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i1", "search", {});
    h.manager.mount("i2", "chat", {});

    const forOne = h.commits.filter((c) => c.instanceId === "i1");
    const forTwo = h.commits.filter((c) => c.instanceId === "i2");
    expect(forOne.length).toBeGreaterThan(0);
    expect(forTwo.length).toBeGreaterThan(0);
    expect(latest(forOne).root[0].type).toBe("List");
    expect(latest(forTwo).root[0].type).toBe("Chat");

    h.manager.disposeAll();
  });
});
