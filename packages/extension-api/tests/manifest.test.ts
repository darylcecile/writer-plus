/**
 * The consent surface is only as honest as this function.
 *
 * `describeCapabilities` is what turns a manifest into the words a user reads
 * before granting access. A bug here does not throw, it just quietly
 * under-reports what an extension can do - which is the one failure mode the
 * permission model cannot tolerate, because the Rust gate will happily enforce
 * a grant the user was never shown.
 */

import { describe, expect, it } from "vite-plus/test";
import { describeCapabilities, validateManifest } from "../src/manifest";

describe("describeCapabilities", () => {
  it("puts `unsafe` in its own tier rather than lumping it with scoped grants", () => {
    // Every other capability is scope-checked; `unsafe` is not. Rendering them
    // at the same tier would let a consent dialog present "runs arbitrary
    // programs" with the same weight as "read notes".
    const described = describeCapabilities({
      workspace: { read: ["**/*.md"], reason: "To answer questions about notes." },
      unsafe: { reason: "Starts the AI assistant you choose." },
    });

    const tiers = Object.fromEntries(described.map((d) => [d.key, d.tier]));
    expect(tiers["workspace.read"]).toBe("install");
    expect(tiers.unsafe).toBe("unsafe");
  });

  it("passes the extension's stated reason through verbatim", () => {
    // The reason is the only thing distinguishing a legitimate request from a
    // pretextual one. Paraphrasing or truncating it would hide the tell.
    const reason = "Starts GitHub Copilot as a separate program on your computer.";
    const [described] = describeCapabilities({ unsafe: { reason } });
    expect(described.reason).toBe(reason);
  });

  it("describes what `unsafe` actually means, not what the extension claims", () => {
    // The detail text is Writer's own words. An extension must not be able to
    // supply the explanation of its own risk.
    const [described] = describeCapabilities({
      unsafe: { reason: "Totally harmless, nothing to see here." },
    });
    expect(described.detail).toContain("start other programs");
    expect(described.detail).toContain("Writer cannot restrict");
  });

  it("reports nothing for a manifest that requests nothing", () => {
    expect(describeCapabilities(undefined)).toEqual([]);
    expect(describeCapabilities({})).toEqual([]);
  });
});

describe("manifest validation of the unsafe tier", () => {
  const base = {
    id: "test-ext",
    name: "Test",
    description: "A test extension",
    version: "1.0.0",
    author: "someone",
    commands: [{ name: "run", title: "Run", mode: "view" as const }],
  };

  it("rejects an `unsafe` grant with no reason", () => {
    // A blank reason produces a consent dialog that asks the user to approve
    // arbitrary code execution without saying what for.
    const result = validateManifest({ ...base, capabilities: { unsafe: { reason: "" } } });
    expect(result.ok).toBe(false);
  });

  it("accepts an `unsafe` grant that explains itself", () => {
    const result = validateManifest({
      ...base,
      capabilities: {
        unsafe: { reason: "Starts the AI assistant you choose as a separate program." },
      },
    });
    expect(result.ok).toBe(true);
  });
});
