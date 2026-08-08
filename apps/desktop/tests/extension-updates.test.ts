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
import {
  type UpdateReport,
  describeCheckAge,
  summarizeUpdates,
} from "../src/components/extension-ui/install";

const report = (over: Partial<UpdateReport> = {}): UpdateReport => ({
  checkedAt: 1_700_000_000,
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

/**
 * The age of a check is part of the claim it makes. "Everything is up to date"
 * from a scheduled run three weeks ago and one from a moment ago read
 * identically without it, and only one of them is worth believing.
 */
describe("describeCheckAge", () => {
  const at = 1_700_000_000;
  const nowMs = (offsetSeconds: number) => (at + offsetSeconds) * 1000;

  it("calls a fresh check just now", () => {
    expect(describeCheckAge(at, nowMs(0))).toBe("just now");
    expect(describeCheckAge(at, nowMs(59))).toBe("just now");
  });

  it("switches units at each boundary", () => {
    expect(describeCheckAge(at, nowMs(60))).toBe("1 minute ago");
    expect(describeCheckAge(at, nowMs(60 * 60))).toBe("1 hour ago");
    expect(describeCheckAge(at, nowMs(24 * 60 * 60))).toBe("1 day ago");
  });

  it("pluralizes", () => {
    expect(describeCheckAge(at, nowMs(120))).toBe("2 minutes ago");
    expect(describeCheckAge(at, nowMs(3 * 24 * 60 * 60))).toBe("3 days ago");
  });

  /**
   * A clock that moved backwards must not render "-4 hours ago", which reads
   * as a bug in the app rather than a wrong clock.
   */
  it("does not render a negative age when the clock moved backwards", () => {
    expect(describeCheckAge(at, nowMs(-60 * 60 * 4))).toBe("just now");
  });
});
