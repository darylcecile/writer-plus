/**
 * QuickJS VM lifecycle for a single extension instance.
 *
 * Everything an extension can reach is injected here. The VM starts with no
 * ambient capabilities at all - no fetch, no filesystem, no timers, no host
 * objects - and gains only what this file hands it. That is the isolation
 * boundary the whole security model rests on, so additions to `__writer` are
 * the thing to scrutinise in review.
 *
 * Two lifecycle rules are load-bearing and easy to get wrong:
 *
 *  1. Every QuickJS handle must be disposed. A leak makes `rt.dispose()` abort
 *     the WASM module with `Assertion failed: list_empty(&rt->gc_obj_list)`,
 *     which surfaces as an opaque crash rather than a leak warning.
 *  2. Timer globals must exist BEFORE the bundle is evaluated. React's
 *     scheduler binds its host callback at module-init time, so injecting them
 *     afterwards is too late and effect-driven updates never render.
 */

import type { QuickJSContext, QuickJSRuntime, QuickJSWASMModule } from "quickjs-emscripten-core";
import type {
  CapabilityRequest,
  CapabilityResult,
  HostTree,
  JsonValue,
} from "@writer/extension-api/protocol";

export interface VmLimits {
  /** Hard ceiling on VM heap. Beyond this, allocation fails inside the VM. */
  memoryBytes: number;
  /** Wall-clock budget for any single synchronous entry into the VM. */
  budgetMs: number;
}

export const DEFAULT_LIMITS: VmLimits = {
  memoryBytes: 64 * 1024 * 1024,
  budgetMs: 2_000,
};

export interface VmCallbacks {
  onCommit(tree: HostTree): void;
  onLog(level: "debug" | "info" | "warn" | "error", message: string): void;
  onCapability(callId: number, request: CapabilityRequest): void;
  onToast(style: string, title: string, message?: string): void;
}

/** A timer scheduled from inside the VM, held on the host side. */
interface HostTimer {
  id: number;
  due: number;
  fnRef: unknown;
}

export class ExtensionVm {
  private runtime: QuickJSRuntime;
  private context: QuickJSContext;
  private disposed = false;

  /** Deadline for the current synchronous entry, read by the interrupt handler. */
  private deadline = Infinity;

  private timers: HostTimer[] = [];
  private nextTimerId = 1;
  private clock = 0;

  /** Handles that live as long as the VM and must be freed on dispose. */
  private retained: Array<{ dispose(): void; alive: boolean }> = [];

  constructor(
    wasm: QuickJSWASMModule,
    private readonly callbacks: VmCallbacks,
    private readonly limits: VmLimits = DEFAULT_LIMITS,
  ) {
    this.runtime = wasm.newRuntime();
    this.runtime.setMemoryLimit(limits.memoryBytes);

    // The backstop against `while(true)`. Returning true halts the VM with an
    // uncatchable error, which is the only way to stop a guest that never
    // yields - the guest cannot try/catch its way out of it.
    this.runtime.setInterruptHandler(() => Date.now() > this.deadline);

    this.context = this.runtime.newContext();
    this.installWriterGlobal();
    this.installTimerGlobals();
  }

  // ------------------------------------------------------------- injection

  /** Track a handle so `dispose()` can free it. */
  private retain<T extends { dispose(): void; alive: boolean }>(handle: T): T {
    this.retained.push(handle);
    return handle;
  }

  /**
   * Define a host function on an object. quickjs-emscripten hands the callback
   * *borrowed* handles: they must be read within the callback and must not be
   * disposed by it.
   */
  private defineFn(target: unknown, name: string, fn: (...args: unknown[]) => unknown): void {
    const ctx = this.context as unknown as {
      newFunction(n: string, f: (...a: unknown[]) => unknown): { dispose(): void; alive: boolean };
      setProp(t: unknown, k: string, v: unknown): void;
    };
    const handle = ctx.newFunction(name, fn);
    ctx.setProp(target, name, handle);
    this.retain(handle);
  }

  private get ctx(): {
    global: unknown;
    newObject(): { dispose(): void; alive: boolean };
    newString(s: string): { dispose(): void; alive: boolean };
    newNumber(n: number): { dispose(): void; alive: boolean };
    setProp(t: unknown, k: string, v: unknown): void;
    getString(h: unknown): string;
    getNumber(h: unknown): number;
    dump(h: unknown): unknown;
    evalCode(code: string, filename?: string): { error?: unknown; value?: unknown };
    unwrapResult(r: unknown): { dispose(): void; alive: boolean };
    callFunction(
      fn: unknown,
      thisVal: unknown,
      ...args: unknown[]
    ): { error?: unknown; value?: unknown };
  } {
    return this.context as never;
  }

  /**
   * `__writer` is the guest's ONLY route out of the VM. Note every payload
   * crosses as a JSON string: `ctx.dump()` does not deep-serialize object
   * graphs - a plain object comes back as the literal string "[object Object]"
   * - so the guest stringifies and the host parses.
   */
  private installWriterGlobal(): void {
    const ctx = this.ctx;
    const writer = this.retain(ctx.newObject());

    this.defineFn(writer, "commit", (json: unknown) => {
      this.callbacks.onCommit(JSON.parse(ctx.getString(json)) as HostTree);
    });

    this.defineFn(writer, "log", (level: unknown, message: unknown) => {
      this.callbacks.onLog(
        ctx.getString(level) as "debug" | "info" | "warn" | "error",
        ctx.getString(message),
      );
    });

    this.defineFn(writer, "capability", (callId: unknown, json: unknown) => {
      this.callbacks.onCapability(
        ctx.getNumber(callId),
        JSON.parse(ctx.getString(json)) as CapabilityRequest,
      );
    });

    this.defineFn(writer, "toast", (json: unknown) => {
      const t = JSON.parse(ctx.getString(json)) as {
        style: string;
        title: string;
        message?: string;
      };
      this.callbacks.onToast(t.style, t.title, t.message);
    });

    // A monotonic virtual clock, not wall time. The guest cannot use it to
    // fingerprint the machine, and it makes timer ordering reproducible.
    this.defineFn(writer, "now", () => ctx.newNumber(this.clock));

    ctx.setProp(ctx.global, "__writer", writer);
  }

  /**
   * Publish `setTimeout`/`clearTimeout` as VM globals.
   *
   * React's scheduler (0.27.0) captures its host callback at module-init time
   * from `setImmediate` -> `MessageChannel` -> `setTimeout`. QuickJS has none
   * of them, so without this the scheduler's `localSetTimeout` is null and any
   * effect-driven update throws instead of rendering. `setImmediate` and
   * `MessageChannel` are deliberately NOT provided, so the scheduler falls
   * through to a queue the host drains explicitly in `runTimers()`.
   */
  private installTimerGlobals(): void {
    const ctx = this.ctx;

    this.defineFn(ctx.global, "setTimeout", (fnRef: unknown, delay: unknown) => {
      const id = this.nextTimerId++;
      const ms = typeof delay === "undefined" ? 0 : ctx.getNumber(delay);
      // The callback handle is borrowed, so it must be duplicated to outlive
      // this call. It is released when the timer runs or is cleared.
      const dup = (fnRef as { dup(): { dispose(): void; alive: boolean } }).dup();
      this.timers.push({ id, due: this.clock + Math.max(0, ms || 0), fnRef: dup });
      return ctx.newNumber(id);
    });

    this.defineFn(ctx.global, "clearTimeout", (idHandle: unknown) => {
      const id = ctx.getNumber(idHandle);
      const found = this.timers.find((t) => t.id === id);
      if (found) (found.fnRef as { dispose(): void }).dispose();
      this.timers = this.timers.filter((t) => t.id !== id);
    });
  }

  // ------------------------------------------------------------- execution

  /** Run `fn` under a fresh time budget. */
  private withBudget<T>(fn: () => T): T {
    this.deadline = Date.now() + this.limits.budgetMs;
    try {
      return fn();
    } finally {
      this.deadline = Infinity;
    }
  }

  /** Evaluate the extension bundle. Throws with the guest stack on failure. */
  evaluate(code: string, filename = "extension.js"): void {
    this.assertAlive();
    this.withBudget(() => {
      const result = this.ctx.evalCode(code, filename);
      this.consume(result);
    });
  }

  /**
   * Call a function on `globalThis.__writer_guest`, then drain timers so any
   * work React scheduled during the call actually runs before returning.
   */
  callGuest(method: string, args: JsonValue[] = []): void {
    this.assertAlive();
    this.withBudget(() => {
      const json = JSON.stringify(args).replace(/</g, "\\u003c");
      const result = this.ctx.evalCode(
        `globalThis.__writer_guest.${method}.apply(null, ${json})`,
        `guest:${method}`,
      );
      this.consume(result);
      this.runTimers();
    });
  }

  /** Deliver a settled capability result back into the VM. */
  resolveCapability(callId: number, result: CapabilityResult): void {
    if (this.disposed) return;
    // The guest entry point takes the result as a JSON string, not an object.
    this.callGuest("capabilityResult", [callId, JSON.stringify(result)]);
  }

  /**
   * Run every due timer, then let React settle.
   *
   * Loops because a timer can schedule another zero-delay timer - React's
   * scheduler does exactly that - and advances the virtual clock when nothing
   * is due so delayed work still fires. Bounded, so a runaway guest degrades
   * to a logged warning instead of hanging the worker; the interrupt handler
   * is the outer backstop for a guest that never returns at all.
   */
  runTimers(): void {
    // Promise reactions sit in QuickJS's own job queue and do NOT run when the
    // stack unwinds the way they do on a host JS engine - the embedder has to
    // drain them. Missing this is silent: a capability resolves, the guest's
    // `.then` never fires, and the UI simply never updates.
    this.drainJobs();

    for (let pass = 0; pass < 1000; pass++) {
      if (this.timers.length === 0) return;
      const due = this.timers.filter((t) => t.due <= this.clock);
      if (due.length === 0) {
        this.clock = Math.min(...this.timers.map((t) => t.due));
        continue;
      }
      this.timers = this.timers.filter((t) => t.due > this.clock);
      for (const timer of due) {
        try {
          const r = this.ctx.callFunction(timer.fnRef, this.ctx.global);
          this.consume(r);
        } catch (error) {
          this.callbacks.onLog("error", `timer threw: ${String(error)}`);
        } finally {
          (timer.fnRef as { dispose(): void }).dispose();
        }
      }
      // A timer callback can resolve a promise, so drain again before deciding
      // the queue is empty.
      this.drainJobs();
    }
    this.callbacks.onLog("warn", "timer queue did not drain in 1000 passes");
  }

  /**
   * Run queued promise reactions until the queue is empty.
   *
   * Bounded because a promise chain that re-queues itself forever would
   * otherwise hang the host; the interrupt handler cannot help here since
   * each individual job returns promptly.
   */
  private drainJobs(): void {
    const runtime = this.runtime as unknown as {
      executePendingJobs(maxJobs?: number): { value?: number; error?: { dispose(): void } };
    };
    for (let pass = 0; pass < 100; pass++) {
      const result = runtime.executePendingJobs();
      if (result.error) {
        const dumped = this.ctx.dump(result.error);
        result.error.dispose();
        this.callbacks.onLog("error", `pending job threw: ${JSON.stringify(dumped)}`);
        return;
      }
      if (!result.value) return;
    }
    this.callbacks.onLog("warn", "promise jobs did not drain in 100 passes");
  }

  /**
   * Free the handle a VM call produced, converting a guest throw into a host
   * error. Not optional-chained on purpose: a swallowed failure here is how
   * the reconciler bug stayed invisible during the spike.
   */
  private consume(result: { error?: unknown; value?: unknown }): void {
    if (result.error) {
      const err = result.error as { dispose(): void };
      const dumped = this.ctx.dump(err);
      err.dispose();
      throw new Error(typeof dumped === "string" ? dumped : JSON.stringify(dumped));
    }
    (result.value as { dispose(): void } | undefined)?.dispose();
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("extension VM has been disposed");
  }

  // --------------------------------------------------------------- teardown

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const timer of this.timers) (timer.fnRef as { dispose(): void }).dispose();
    this.timers = [];

    // Reverse order: handles defined on an object are freed before the object.
    for (const handle of this.retained.reverse()) {
      if (handle.alive) handle.dispose();
    }
    this.retained = [];

    this.context.dispose();
    this.runtime.dispose();
  }
}
