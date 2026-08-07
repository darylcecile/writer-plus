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

  it("installTimerGlobals publishes timers and removes the alternatives", async () => {
    (g as { __writer?: unknown }).__writer = {
      commit: () => {},
      log: () => {},
      capability: () => {},
      toast: () => {},
      now: () => 0,
    };

    const { installTimerGlobals } = await import("../src/runtime/bridge");

    const target: Record<string, unknown> = {
      setImmediate: () => {},
      MessageChannel: class {},
    };
    installTimerGlobals(target);

    expect(target.setImmediate).toBeUndefined();
    expect(target.MessageChannel).toBeUndefined();
    expect(typeof target.setTimeout).toBe("function");
    expect(typeof target.clearTimeout).toBe("function");
  });

  it("delegates to a host-installed setTimeout rather than keeping a second queue", async () => {
    // The invariant that matters. In the VM the host installs `setTimeout`
    // before React's scheduler initialises, so the scheduler schedules onto the
    // host queue. If the bridge kept its own queue as well, scheduler work and
    // committed frames would sit on different queues and one would never drain
    // - which is how effect-driven updates silently stopped rendering.
    const seen: number[] = [];
    const original = g.setTimeout as (f: () => void, d: number) => number;
    g.setTimeout = (fn: () => void, delay: number) => {
      seen.push(delay);
      return original(fn, delay);
    };

    (g as { __writer?: unknown }).__writer = {
      commit: () => {},
      log: () => {},
      capability: () => {},
      toast: () => {},
      now: () => 0,
    };

    try {
      const { bridge } = await import("../src/runtime/bridge");
      let ran = false;
      bridge.setTimeout(() => {
        ran = true;
      }, 0);

      expect(seen, "bridge must schedule through the host global").toHaveLength(1);
      // Nothing was queued locally, so draining the host queue is what runs it.
      (g as unknown as { __vmTimers: { run(): void } }).__vmTimers.run();
      expect(ran).toBe(true);
    } finally {
      g.setTimeout = original;
    }
  });
});
