/**
 * Ambient globals available inside the sandbox.
 *
 * This list is exhaustive and deliberately short. It mirrors exactly what the
 * host injects into the VM (see `ExtensionVm.installTimerGlobals`), so if a
 * name is not declared here it genuinely does not exist at runtime - there is
 * no `fetch`, no `process`, no `require`, no DOM.
 *
 * Timers are declared because React's scheduler needs them and extensions
 * legitimately use them for debouncing. They run on the host's virtual clock,
 * so they are pumped between guest calls rather than firing spontaneously.
 */

declare global {
  function setTimeout(handler: () => void, timeout?: number): number;
  function clearTimeout(id: number | undefined): void;
}

export {};
