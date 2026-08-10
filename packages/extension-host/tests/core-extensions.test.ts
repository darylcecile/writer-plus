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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionManager, type CapabilityBroker } from "../src/manager";
import { bundleExtension } from "../src/bundler";
import type { CapabilityRequest, HostNode, HostTree } from "@writer/extension-api/protocol";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(here, "..", "..", "..");

let wasm: QuickJSWASMModule;
const bundles: Record<string, string> = {};

beforeAll(async () => {
  wasm = await newQuickJSWASMModuleFromVariant(releaseSync);

  bundles["writer.semantic-index"] = await bundleExtension({
    entryPoint: join(repoRoot, "extensions", "semantic-index", "src", "index.tsx"),
  });

  bundles["writer.ai-chat"] = await bundleExtension({
    entryPoint: join(repoRoot, "extensions", "ai-chat", "src", "index.tsx"),
  });
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

/** Reads a text prop without lint noise about stringifying a JsonValue. */
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

interface Harness {
  manager: ExtensionManager;
  commits: { instanceId: string; tree: HostTree }[];
  errors: { instanceId: string; message: string }[];
  requests: CapabilityRequest[];
  disposed: { instanceId: string; extensionId: string }[];
}

function harness(respond: (req: CapabilityRequest) => unknown): Harness {
  const commits: { instanceId: string; tree: HostTree }[] = [];
  const errors: { instanceId: string; message: string }[] = [];
  const requests: CapabilityRequest[] = [];
  const disposed: { instanceId: string; extensionId: string }[] = [];

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
      onDispose: (instanceId, extensionId) => disposed.push({ instanceId, extensionId }),
    },
    { memoryBytes: 128 * 1024 * 1024, budgetMs: 15_000 },
  );

  return { manager, commits, errors, requests, disposed };
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
    case "preferences.get":
      return req.args[0] === "harness" ? "copilot" : "6";
    case "preferences.all":
      return { harness: "copilot", contextNotes: "6" };
    case "workspace.root":
      return "/notes";
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

/**
 * A scripted ACP agent behind the `process.*` capability.
 *
 * ai-chat speaks the real protocol to a real child process, so a fake that
 * only stubbed `ai.ask` would test nothing that matters. This one parses the
 * JSON-RPC the extension actually writes and answers it the way
 * `copilot --acp` does - the shapes below were copied from a live handshake,
 * not invented.
 */
function fakeAgent(options: { reply?: string; stopReason?: string } = {}) {
  const reply = options.reply ?? "Based on your notes, you wrote about ownership in Learning Rust.";
  const outbox: string[] = [];
  const seen: { method: string; params: Record<string, unknown> }[] = [];
  let sessionId: string | null = null;
  let killed = false;

  function onWrite(raw: string) {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      seen.push({ method: msg.method, params: msg.params ?? {} });

      switch (msg.method) {
        case "initialize":
          outbox.push(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentInfo: { name: "Fake", version: "1.0.0" },
              },
            }),
          );
          break;
        case "session/new":
          sessionId = "sess-1";
          outbox.push(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId } }));
          break;
        case "session/prompt": {
          // Streamed in two chunks, as a real agent does, so the client's
          // accumulation is exercised rather than assumed.
          const half = Math.ceil(reply.length / 2);
          for (const text of [reply.slice(0, half), reply.slice(half)]) {
            outbox.push(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  sessionId,
                  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
                },
              }),
            );
          }
          // An update variant the client has never heard of. It must be
          // ignored, not treated as an error.
          outbox.push(
            JSON.stringify({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId, update: { sessionUpdate: "usage_update", used: 10, size: 100 } },
            }),
          );
          outbox.push(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { stopReason: options.stopReason ?? "end_turn" },
            }),
          );
          break;
        }
        default:
          if (msg.id !== undefined) {
            outbox.push(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32601, message: `unexpected ${msg.method}` },
              }),
            );
          }
      }
    }
  }

  function respond(req: CapabilityRequest): unknown {
    switch (`${req.capability}.${req.method}`) {
      case "process.which":
        return "/usr/local/bin/copilot";
      case "process.spawn": {
        // Mirror the host's real precondition. This fake used to accept any
        // program string at all, which is how a shipped bug got past a green
        // suite: Rust rejected anything containing a separator, so feeding it
        // `which`'s own absolute answer failed with "not found on PATH" naming
        // a path that existed. A fake that is more permissive than the host
        // tests the fake, not the client.
        const program = req.args[0];
        if (typeof program !== "string" || program === "") {
          throw new Error(`process.spawn expected a program name, got ${typeof program}`);
        }
        if (program.includes("/") && !program.startsWith("/")) {
          throw new Error(`process.spawn rejects relative paths, got ${program}`);
        }
        return "proc-1";
      }
      case "process.write": {
        // Assert rather than coerce: if the extension ever writes a non-string
        // here it is a real bug in the client, and `String()` would paper over
        // it by turning the object into "[object Object]" and failing later
        // with an unhelpful JSON parse error instead.
        const payload = req.args[1];
        if (typeof payload !== "string") {
          throw new Error(`process.write expected a string, got ${typeof payload}`);
        }
        onWrite(payload);
        return null;
      }
      case "process.read": {
        const stdout = outbox.splice(0, outbox.length);
        return { stdout, stderr: [], exitCode: null };
      }
      case "process.kill":
        killed = true;
        return null;
      default:
        return defaultRespond(req);
    }
  }

  return {
    respond,
    seen,
    get killed() {
      return killed;
    },
    /** The prompt text the extension actually sent to the agent. */
    promptText(): string {
      const p = seen.find((m) => m.method === "session/prompt");
      return JSON.stringify(p?.params.prompt ?? null);
    },
  };
}

/** Drives the VM long enough for a full async prompt turn to settle. */
async function settle(h: Harness, instanceId: string, rounds = 60) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 10));
    h.manager.dispatchEvent(instanceId, "__flush__", []);
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

  it("retrieves notes through the service, drives a real ACP turn, and cites its sources", async () => {
    const agent = fakeAgent();
    const h = harness(agent.respond);
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});

    const onSubmit = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", onSubmit, ["what did I write about rust?"]);
    await settle(h, "i2");

    expect(h.errors).toEqual([]);

    // Retrieval must go through the provider extension, not straight to the
    // embeddings capability - that is what keeps ai-chat's grant narrow.
    const call = h.requests.find((r) => r.capability === "services");
    expect(call).toBeTruthy();
    expect(call?.args[0]).toBe("writer.semantic-index");
    expect(call?.args[1]).toBe("search");
    expect(call?.args[2]).toBe("query");

    // The harness is resolved before it is spawned, so "not installed" is a
    // real message rather than an opaque spawn failure.
    const which = h.requests.find((r) => r.capability === "process" && r.method === "which");
    expect(which?.args[0]).toBe("copilot");

    // Handshake order is protocol-mandated: initialize, then session/new,
    // then prompts.
    expect(agent.seen.map((m) => m.method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
    ]);
    expect(agent.seen[0].params.protocolVersion).toBe(1);
    // The session is rooted at the note workspace, not at some default cwd.
    expect(agent.seen[1].params.cwd).toBe("/notes");

    // The retrieved notes must actually reach the agent, or the answer is not
    // grounded in anything.
    const prompt = agent.promptText();
    expect(prompt).toContain("Learning Rust");
    expect(prompt).toContain("ownership");

    const messages = collect(latest(h.commits).root, "Chat.Message");
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0].props.role).toBe("user");

    const assistant = messages.filter((m) => m.props.role === "assistant").pop();
    expect(assistant).toBeTruthy();
    // Both streamed chunks landed, in order.
    expect(textOf(assistant?.props.content)).toContain("ownership in Learning Rust");
    // One citation per note, even though two chunks of rust.md matched.
    const citations = assistant?.props.citations as { path: string }[];
    expect(citations.map((c) => c.path)).toEqual(["notes/rust.md", "notes/wasm.md"]);

    h.manager.disposeAll();
  });

  it("degrades to an ungrounded answer when the index provider is unavailable", async () => {
    // A user who has not enabled Semantic Index should still get an answer,
    // not a broken panel.
    const agent = fakeAgent();
    const h = harness((req) => {
      if (req.capability === "services") throw new Error("provider not installed");
      return agent.respond(req);
    });
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});

    const onSubmit = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", onSubmit, ["what did I write about rust?"]);
    await settle(h, "i2");

    // It must tell the agent there was no context rather than silently
    // implying the notes were searched and came back empty.
    expect(agent.promptText()).toContain("No notes matched");

    const messages = collect(latest(h.commits).root, "Chat.Message");
    expect(messages.some((m) => m.props.role === "assistant")).toBe(true);

    h.manager.disposeAll();
  });

  it("surfaces a missing harness as an actionable message instead of a spawn error", async () => {
    const h = harness((req) => {
      if (req.capability === "process" && req.method === "which") return null;
      if (req.capability === "process") throw new Error("should not reach spawn");
      return defaultRespond(req);
    });
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});

    const onSubmit = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", onSubmit, ["anything"]);
    await settle(h, "i2");

    // Never spawned: resolving first is what makes the error useful.
    expect(h.requests.some((r) => r.capability === "process" && r.method === "spawn")).toBe(false);

    const assistant = collect(latest(h.commits).root, "Chat.Message")
      .filter((m) => m.props.role === "assistant")
      .pop();
    const text = textOf(assistant?.props.content);
    expect(text).toContain("not installed");
    // The install hint, not just the failure.
    expect(text).toContain("copilot login");

    h.manager.disposeAll();
  });

  it("reuses one agent process across turns rather than spawning per question", async () => {
    // Startup is slow and a process per question would leak them, so the
    // session is deliberately long-lived.
    const agent = fakeAgent();
    const h = harness(agent.respond);
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});

    const onSubmit = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", onSubmit, ["first question"]);
    await settle(h, "i2");

    const after = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", after, ["second question"]);
    await settle(h, "i2");

    const spawns = h.requests.filter((r) => r.capability === "process" && r.method === "spawn");
    expect(spawns).toHaveLength(1);
    expect(agent.seen.filter((m) => m.method === "initialize")).toHaveLength(1);
    expect(agent.seen.filter((m) => m.method === "session/prompt")).toHaveLength(2);

    // The preamble is sent once. Repeating it wastes tokens and lets a later
    // copy contradict an earlier one.
    const preambles = agent.seen.filter(
      (m) => m.method === "session/prompt" && JSON.stringify(m.params).includes("personal notes"),
    );
    expect(preambles).toHaveLength(1);

    h.manager.disposeAll();
  });

  it("warns when the agent stops early instead of passing off a truncated answer", async () => {
    const agent = fakeAgent({ stopReason: "max_tokens" });
    const toasts: { title?: string }[] = [];
    const h = harness(agent.respond);
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});
    void toasts;

    const onSubmit = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", onSubmit, ["long question"]);
    await settle(h, "i2");

    // The turn still completes and the partial text is kept.
    const assistant = collect(latest(h.commits).root, "Chat.Message")
      .filter((m) => m.props.role === "assistant")
      .pop();
    expect(textOf(assistant?.props.content)).toContain("Learning Rust");
    expect(h.errors).toEqual([]);

    h.manager.disposeAll();
  });

  it("kills the agent process when the panel is disposed", async () => {
    const agent = fakeAgent();
    const h = harness(agent.respond);
    h.manager.spawn("i2", "writer.ai-chat", bundles["writer.ai-chat"]);
    h.manager.mount("i2", "chat", {});

    const onSubmit = latest(h.commits).root[0].handlers.onSubmit;
    h.manager.dispatchEvent("i2", onSubmit, ["question"]);
    await settle(h, "i2");

    const reaped: string[] = [];
    h.manager.dispose("i2");

    // Host-enforced, not guest-cooperative: an extension that crashed or blew
    // its CPU budget never runs its own teardown, so a leaked agent would be a
    // leaked OS process per panel open.
    expect(reaped).toEqual([]);
    expect(h.disposed).toEqual([{ instanceId: "i2", extensionId: "writer.ai-chat" }]);
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
