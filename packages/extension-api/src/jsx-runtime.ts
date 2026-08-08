/**
 * JSX runtime re-export.
 *
 * Extensions set `jsxImportSource` to this package so JSX compiles against
 * the same React instance the runtime uses. Without it an extension resolves
 * `react/jsx-runtime` from its own tree and can end up with a second React,
 * whose elements this package's reconciler does not recognise.
 *
 * The `JSX` namespace must be re-exported alongside the factories: it is where
 * `IntrinsicAttributes` (and therefore `key`) is declared, and pointing
 * `jsxImportSource` here would otherwise leave TypeScript with no definition
 * of it at all.
 */

export { Fragment, jsx, jsxs } from "react/jsx-runtime";
export type { JSX } from "react/jsx-runtime";
