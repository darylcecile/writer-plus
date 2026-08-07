/**
 * Make the test environment an honest model of the QuickJS VM.
 *
 * Node has `setImmediate` and `MessageChannel`; QuickJS has neither. React's
 * scheduler picks its host callback from those globals at module-init time, so
 * without this file every test would exercise a scheduling path that cannot
 * exist in production - which is exactly how the effect-driven update bug
 * stayed invisible until it was traced.
 *
 * Registered as a vitest `setupFiles` entry so it runs before any test module
 * imports React.
 */
interface Timer {
  id: number;
  due: number;
  fn: () => void;
}

let timers: Timer[] = [];
let nextId = 1;
let clock = 0;

const g = globalThis as unknown as Record<string, unknown>;

delete g.setImmediate;
delete g.MessageChannel;

g.setTimeout = (fn: () => void, delay = 0) => {
  const id = nextId++;
  timers.push({ id, due: clock + Math.max(0, delay), fn });
  return id;
};
g.clearTimeout = (id: number) => {
  timers = timers.filter((t) => t.id !== id);
};

/** Drain due timers, advancing the fake clock so delayed work still runs. */
function run(): void {
  for (let pass = 0; pass < 1000; pass++) {
    if (timers.length === 0) return;
    const due = timers.filter((t) => t.due <= clock);
    if (due.length === 0) {
      clock = Math.min(...timers.map((t) => t.due));
      continue;
    }
    timers = timers.filter((t) => t.due > clock);
    for (const t of due) t.fn();
  }
  throw new Error("timer queue did not drain in 1000 passes");
}

g.__vmTimers = {
  run,
  now: () => clock,
  pending: () => timers.length,
  reset: () => {
    timers = [];
    clock = 0;
  },
};
