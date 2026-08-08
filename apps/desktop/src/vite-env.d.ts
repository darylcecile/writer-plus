/// <reference types="vite/client" />

/**
 * True only in builds produced by the E2E script (`VITE_E2E=1`). Substituted
 * at build time by the `define` in vite.config.ts, so test-only affordances
 * are dropped entirely from a normal release bundle.
 */
declare const __E2E__: boolean;
