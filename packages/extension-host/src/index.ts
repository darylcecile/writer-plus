/**
 * Public surface of the extension host.
 *
 * Everything an embedder needs is here; nothing else in this package is
 * intended to be imported directly. `ExtensionVm` is exported for tests and
 * for embedders that need to drive a single VM by hand, but normal use should
 * go through `ExtensionManager`, which owns lifecycle and commit ordering.
 */

export { ExtensionManager } from "./manager.js";
export type { InstanceEvents, CapabilityBroker } from "./manager.js";

export { createBroker } from "./broker.js";
export type { BrokerOptions, GrantedPermissions, RustInvoke, ServiceRouter } from "./broker.js";

export { ExtensionVm, DEFAULT_LIMITS } from "./vm.js";
export type { VmLimits, VmCallbacks } from "./vm.js";
