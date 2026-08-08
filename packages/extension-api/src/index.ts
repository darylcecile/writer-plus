/**
 * `@writer/api` — the entire surface available to an extension.
 *
 * Anything not exported here is unreachable from inside the sandbox. There is
 * no escape hatch by design: no `fetch`, no `require`, no DOM, no Tauri IPC.
 */

export * from "./components";
export * from "./capabilities";
export * from "./types";
export * from "./feedback";
export type { JsonValue } from "./protocol";
export type { ExtensionModule } from "./runtime";

// Re-exported so extensions never bundle a second, incompatible React.
export {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useReducer,
  Fragment,
  type ReactNode,
} from "react";
