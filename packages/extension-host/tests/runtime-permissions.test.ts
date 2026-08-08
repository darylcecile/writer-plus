/**
 * Runtime permission prompts, end to end through a real QuickJS VM.
 *
 * The unit tests either side of this one cover the parts: Rust decides, the
 * broker asks and retries, the store remembers. This is the only test where a
 * real guest extension calls a capability, is refused, waits on a real prompt,
 * and then sees the result - which is the behaviour a user actually
 * experiences.
 *
 * It matters because the parts can each be right while the whole is broken.
 * The guest side runs in QuickJS, which does not drain promise reactions when
 * the stack unwinds; a retry that resolves the host promise but never wakes the
 * guest would pass every unit test in the suite and still leave the extension
 * frozen forever.
 *
 * The Rust error string is reproduced verbatim rather than referenced, because
 * it crosses a language boundary as text. A Rust-side test pins the same
 * string, so the two failing together is the signal that the contract moved.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExtensionManager } from "../src/manager";
import { bundleExtension } from "../src/bundler";
import { createBroker, type GrantedPermissions } from "../src/broker";
import type { HostNode, HostTree } from "@writer/extension-api/protocol";

const here = fileURLToPath(new URL(".", import.meta.url));

let wasm: QuickJSWASMModule;
let bundle: string;

beforeAll(async () => {
  wasm = await newQuickJSWASMModuleFromVariant(releaseSync);
  bundle = await bundleExtension({
    entryPoint: join(here, "fixtures", "writing-extension", "index.tsx"),
  });
}, 180_000);

/** Exactly what `AppError::NeedsApproval` serializes to. */
const rustNeedsApproval = (key: string) => new Error(`needs-approval: ${key}`);

function collect(nodes: HostNode[], type: string, out: HostNode[] = []): HostNode[] {
  for (const node of nodes) {
    if (node.type === type) out.push(node);
    collect(node.children, type, out);
  }
  return out;
}

function markdownOf(tree: HostTree | undefined): string {
  if (!tree) return "";
  const detail = collect(tree.root, "Detail")[0];
  const value = detail?.props.markdown;
  return typeof value === "string" ? value : "";
}

interface Scenario {
  /** What the user clicks, or `undefined` to leave the host unable to ask. */
  choice?: "once" | "always" | "never";
}

async function run({ choice }: Scenario) {
  const granted = new Map<string, GrantedPermissions>([
    ["w.test", { capabilities: ["workspace"], usesServices: [], providesServices: [] }],
  ]);

  /** Permission keys Rust has been told about. */
  const recorded: { key: string; decision: string }[] = [];
  const prompts: string[] = [];

  const broker = createBroker({
    grants: granted,
    invoke: (command, args) => {
      if (command === "extension_grant_set") {
        recorded.push({
          key: String(args.key),
          decision: String(args.decision),
        });
        return Promise.resolve(null);
      }
      // Stands in for the real Rust gate: refuse the write until a decision
      // for that exact key has been recorded.
      const capability = String(args.capability);
      const method = String(args.method);
      if (capability === "workspace" && method === "write") {
        const allowed = recorded.some((r) => r.key === "workspace.write");
        return allowed
          ? Promise.resolve(null)
          : Promise.reject(rustNeedsApproval("workspace.write"));
      }
      return Promise.resolve(null);
    },
    requestApproval: choice
      ? (_extensionId, key) => {
          prompts.push(key);
          return Promise.resolve(choice);
        }
      : undefined,
  });

  const commits: HostTree[] = [];
  const manager = new ExtensionManager(
    wasm,
    broker,
    {
      onCommit: (_id, tree) => commits.push(tree),
      onError: () => {},
      onLog: () => {},
      onToast: () => {},
      onDispose: () => {},
    },
    { memoryBytes: 64 * 1024 * 1024, budgetMs: 10_000 },
  );

  manager.spawn("i1", "w.test", bundle);
  manager.mount("i1", "write", {});

  // The guest awaits a host promise, so settling needs both real time (the
  // broker's own awaits) and a VM job drain. Dispatching an unknown handler is
  // the manager's drain hook; the same idiom the core-extension tests use.
  for (let i = 0; i < 60 && markdownOf(commits[commits.length - 1]) === "writing"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    manager.dispatchEvent("i1", "__flush__", []);
  }

  const result = markdownOf(commits[commits.length - 1]);
  manager.disposeAll();
  return { result, recorded, prompts };
}

describe("runtime permission prompt, in a real VM", () => {
  it("lets the write through after the user allows it, and wakes the guest", async () => {
    const { result, prompts, recorded } = await run({ choice: "always" });

    expect(prompts).toEqual(["workspace.write"]);
    expect(recorded).toEqual([{ key: "workspace.write", decision: "always" }]);
    // The guest's own promise resolved. Asserting on the rendered tree rather
    // than on the broker's return value is the point: a retry the guest never
    // sees is a frozen extension.
    expect(result).toBe("wrote");
  }, 60_000);

  it("does not write when the user declines, and tells the guest so", async () => {
    const { result, prompts, recorded } = await run({ choice: "never" });

    expect(prompts).toEqual(["workspace.write"]);
    expect(recorded).toEqual([]);
    expect(result).toContain("refused");
  }, 60_000);

  it("records allow-once as once rather than promoting it", async () => {
    const { result, recorded } = await run({ choice: "once" });

    expect(recorded).toEqual([{ key: "workspace.write", decision: "once" }]);
    expect(result).toBe("wrote");
  }, 60_000);

  /** No way to ask means no way to consent - and must never mean "allow". */
  it("refuses when the host has no way to prompt", async () => {
    const { result, recorded } = await run({});

    expect(recorded).toEqual([]);
    expect(result).toContain("refused");
  }, 60_000);
});
