/**
 * What an update check is allowed to claim.
 *
 * The dangerous outcome is not a missed update, it is a *confident* one: if a
 * check that partly failed reports "everything is up to date", a user with a
 * revoked token or a renamed repository sits on a stale version and is told
 * they are current. The distinction is small enough to look obvious and
 * exactly the kind that gets collapsed during a refactor.
 */

import { describe, expect, it } from "vite-plus/test";
import { type UpdateReport, summarizeUpdates } from "../src/components/extension-ui/install";

const report = (over: Partial<UpdateReport> = {}): UpdateReport => ({
  available: [],
  errors: [],
  ...over,
});

const update = (id: string) => ({
  id,
  repo: "owner/repo",
  installedVersion: "1.0.0",
  latestVersion: "1.1.0",
});

describe("summarizeUpdates", () => {
  it("says nothing before a check has run", () => {
    // Distinct from "up to date": we have not looked yet.
    expect(summarizeUpdates(null)).toEqual({ kind: "not-checked" });
  });

  it("reports up to date only when everything was actually checked", () => {
    expect(summarizeUpdates(report())).toEqual({ kind: "up-to-date" });
  });

  it("counts available updates", () => {
    expect(summarizeUpdates(report({ available: [update("a"), update("b")] }))).toEqual({
      kind: "updates",
      count: 2,
    });
  });

  it("never claims up to date when an extension could not be checked", () => {
    const result = summarizeUpdates(report({ errors: [{ id: "a", message: "401" }] }));

    expect(result.kind).toBe("partial");
    expect(result).toEqual({ kind: "partial", count: 0, failed: 1 });
  });

  it("still reports failures when other extensions did have updates", () => {
    // The failure must not be hidden behind the good news.
    expect(
      summarizeUpdates(
        report({ available: [update("a")], errors: [{ id: "b", message: "not found" }] }),
      ),
    ).toEqual({ kind: "partial", count: 1, failed: 1 });
  });
});
