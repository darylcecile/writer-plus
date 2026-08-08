/**
 * The rule that decides whether a user gets interrupted.
 *
 * `needsConsent` is small enough to look obviously correct and important
 * enough that "obviously correct" is not good enough. Getting it wrong in one
 * direction silently applies a privilege escalation; getting it wrong in the
 * other trains users to dismiss consent dialogs without reading them, which
 * disarms every dialog that follows.
 */

import { describe, expect, it } from "vite-plus/test";
import { type InstallCandidate, needsConsent } from "../src/components/extension-ui/install";

function candidate(overrides: Partial<InstallCandidate> = {}): InstallCandidate {
  return {
    repo: "owner/repo",
    manifest: { id: "test.ext", name: "Test", author: "someone", version: "1.0.0" },
    permissions: [],
    version: "1.0.0",
    bundleSha256: "abc",
    replacesVersion: null,
    addedCapabilities: [],
    requiresUnsafe: false,
    ...overrides,
  };
}

describe("needsConsent", () => {
  it("always asks on a first install", () => {
    // Nothing was previously agreed to, so every capability is new even when
    // the diff against "nothing installed" is reported as empty.
    expect(needsConsent(candidate({ replacesVersion: null }))).toBe(true);
  });

  it("still asks on a first install of an extension that requests nothing", () => {
    // The dialog is also where the user learns what they are installing and
    // from whom, not only which permissions it wants.
    expect(needsConsent(candidate({ replacesVersion: null, permissions: [] }))).toBe(true);
  });

  it("does not interrupt for an update that asks for nothing new", () => {
    // A maintenance release that re-prompts is how users learn to click
    // through. The dialog has to stay rare to stay meaningful.
    expect(
      needsConsent(
        candidate({ replacesVersion: "1.0.0", version: "1.0.1", addedCapabilities: [] }),
      ),
    ).toBe(false);
  });

  it("stops an update that quietly gained a capability", () => {
    // This is the supply-chain control: "the extension you already trusted now
    // wants to spawn processes" must be a decision, not a background task.
    expect(
      needsConsent(
        candidate({
          replacesVersion: "1.0.0",
          version: "2.0.0",
          addedCapabilities: ["unsafe"],
          requiresUnsafe: true,
        }),
      ),
    ).toBe(true);
  });

  it("stops an update that widened a grant it already had", () => {
    // Rust reports a widened glob as an added capability even though the
    // capability name is unchanged; this asserts the frontend acts on that
    // rather than comparing names itself.
    expect(
      needsConsent(
        candidate({
          replacesVersion: "1.0.0",
          version: "1.1.0",
          addedCapabilities: ["workspace read=** write=-"],
        }),
      ),
    ).toBe(true);
  });

  it("does not use requiresUnsafe as the trigger on an update", () => {
    // An extension that was already approved with `unsafe` must not re-prompt
    // on every subsequent release; the decision was made once, and the diff -
    // not the presence of the tier - is what changed.
    expect(
      needsConsent(
        candidate({
          replacesVersion: "1.0.0",
          version: "1.0.1",
          requiresUnsafe: true,
          addedCapabilities: [],
        }),
      ),
    ).toBe(false);
  });
});
