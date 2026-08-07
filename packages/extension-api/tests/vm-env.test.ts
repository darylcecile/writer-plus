/**
 * Guards the scheduling contract between the guest and React.
 *
 * React's scheduler (0.27.0) picks its host callback once, at module-init time,
 * from `setImmediate` -> `MessageChannel` -> `setTimeout`. QuickJS provides
 * none of these. If the VM ever gains `setImmediate` or `MessageChannel`,
 * React would schedule onto a loop the host cannot pump and effect-driven
 * updates would silently stop rendering - the exact failure this suite exists
 * to prevent from recurring.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

const g = globalThis as unknown as Record<string, unknown>;

describe("VM scheduling environment", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("has no ambient scheduling primitives React would prefer over setTimeout", () => {
    // If either of these becomes defined, scheduler stops using our pumpable
    // setTimeout and the host loses control of when React renders.
    expect(typeof g.setImmediate).toBe("undefined");
    expect(typeof g.MessageChannel).toBe("undefined");
    expect(typeof g.setTimeout).toBe("function");
  });

  it("installTimerGlobals publishes pumpable timers and removes the alternatives", async () => {
    const injected: Array<{ fn: () => void; delay: number }> = [];
    (g as { __writer?: unknown }).__writer = {
      commit: () => {},
      log: () => {},
      capability: () => {},
      toast: () => {},
      now: () => 0,
    };

    const { installTimerGlobals, bridge } = await import("../src/runtime/bridge");

    const target: Record<string, unknown> = {
      setImmediate: () => {},
      MessageChannel: class {},
    };
    installTimerGlobals(target);

    expect(target.setImmediate).toBeUndefined();
    expect(target.MessageChannel).toBeUndefined();
    expect(typeof target.setTimeout).toBe("function");

    // A timer scheduled through the installed global must land in the bridge
    // queue, which is what `runTimers` drains.
    (target.setTimeout as (fn: () => void, d: number) => number)(
      () => injected.push({ fn: () => {}, delay: 0 }),
      0,
    );
    expect(bridge.hasPendingWork()).toBe(true);
    bridge.runTimers();
    expect(injected).toHaveLength(1);
    expect(bridge.hasPendingWork()).toBe(false);
  });
});
