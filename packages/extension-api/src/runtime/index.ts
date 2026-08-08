/**
 * Guest bootstrap. The host evaluates the extension bundle, then calls the
 * functions this module hangs off `globalThis.__writer_guest`.
 *
 * Kept deliberately tiny: it is the only guest code the host invokes directly,
 * so every entry point here is part of the trust boundary's contract.
 */

import { Component, createElement, type ComponentType, type ReactNode } from "react";
import { flushWork, invokeHandler, mount, unmount } from "./reconciler";
import { bridge, resolveCapability } from "./bridge";
import { dispatchService } from "../capabilities";
import type { CapabilityResult, JsonValue } from "../protocol";

export interface ExtensionModule {
  commands: Record<string, ComponentType<Record<string, unknown>>>;
}

let loaded: ExtensionModule | null = null;

interface GuestApi {
  register(mod: ExtensionModule): void;
  mount(command: string, propsJson: string): void;
  event(handlerId: string, argsJson: string): void;
  capabilityResult(callId: number, resultJson: string): void;
  service(service: string, method: string, argsJson: string): Promise<string>;
  flush(): void;
  dispose(): void;
}

const guest: GuestApi = {
  register(mod) {
    loaded = mod;
  },

  mount(command, propsJson) {
    if (!loaded) throw new Error("extension module did not register a command map");
    const Component = loaded.commands[command];
    if (!Component) {
      const known = Object.keys(loaded.commands).join(", ") || "(none)";
      throw new Error(`unknown command '${command}'; bundle exports: ${known}`);
    }
    const props = JSON.parse(propsJson) as Record<string, unknown>;
    mount(createElement(ErrorBoundary, null, createElement(Component, props)));
  },

  event(handlerId, argsJson) {
    invokeHandler(handlerId, JSON.parse(argsJson) as unknown[]);
    flushWork();
  },

  capabilityResult(callId, resultJson) {
    resolveCapability(callId, JSON.parse(resultJson) as CapabilityResult);
    flushWork();
  },

  async service(service, method, argsJson) {
    const args = JSON.parse(argsJson) as unknown[];
    const value = (await dispatchService(service, method, args)) as JsonValue;
    return JSON.stringify({ ok: true, value });
  },

  flush() {
    flushWork();
  },

  dispose() {
    unmount();
    loaded = null;
  },
};

/**
 * Catches render errors so one bad component reports a readable error instead
 * of leaving the panel blank. Class component because error boundaries have
 * no hook equivalent.
 */
class ErrorBoundary extends Component<{ children?: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown) {
    bridge.log("error", `render failed: ${String(error)}`);
  }

  render() {
    if (this.state.error) {
      return createElement("Detail", {
        markdown: `## Extension error\n\n\`\`\`\n${this.state.error}\n\`\`\``,
      });
    }
    return this.props.children;
  }
}

(globalThis as unknown as { __writer_guest: GuestApi }).__writer_guest = guest;

export { guest };
