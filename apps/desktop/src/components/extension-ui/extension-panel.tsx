/**
 * Panel that hosts one running extension.
 *
 * Deliberately thin: it owns the committed tree and forwards events. All
 * policy (what an extension may do) lives in the broker and in Rust, not
 * here, so this component stays a dumb renderer even if an extension is
 * hostile.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostTree, JsonValue } from "@writer/extension-api/protocol";
import type { ExtensionManager } from "@writer/extension-host";
import { ExtensionTree } from "./renderers";

export interface ExtensionPanelProps {
  manager: ExtensionManager;
  instanceId: string;
  /** Command to mount, as declared in the extension manifest. */
  command: string;
  tree: HostTree | undefined;
  error?: { message: string; fatal: boolean };
}

export function ExtensionPanel({ manager, instanceId, command, tree, error }: ExtensionPanelProps) {
  const mounted = useRef(false);

  useEffect(() => {
    // Mount once per instance+command. Re-mounting on every render would
    // reset the extension's state on any unrelated parent update.
    if (mounted.current) return;
    mounted.current = true;
    manager.mount(instanceId, command, {});
  }, [manager, instanceId, command]);

  const dispatch = useCallback(
    (handlerId: string, args: JsonValue[]) => {
      manager.dispatchEvent(instanceId, handlerId, args);
    },
    [manager, instanceId],
  );

  if (error?.fatal) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            This extension stopped running
          </p>
          <p className="mt-1 text-xs text-[var(--text-tertiary)]">{error.message}</p>
        </div>
      </div>
    );
  }

  if (!tree) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-xs text-[var(--text-tertiary)]">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {error && !error.fatal ? (
        <div className="border-b border-[var(--line-subtle)] px-3 py-1.5 text-xs text-[var(--text-tertiary)]">
          {error.message}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <ExtensionTree root={tree.root} dispatch={dispatch} />
      </div>
    </div>
  );
}

export interface DevSelfTestResult {
  engine: string;
  ok: boolean;
  detail: string;
}

/**
 * Boots a trivial extension and reports whether the VM works in the current
 * WebView.
 *
 * This exists because WebKit enforces CSP for WebAssembly, and a policy
 * regression would otherwise show up only as "extensions mysteriously stopped
 * working". Running it in the real app window is the only way to know; a
 * browser test is a proxy, not proof.
 */
export function useVmSelfTest(enabled: boolean): DevSelfTestResult | null {
  const [result, setResult] = useState<DevSelfTestResult | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    void (async () => {
      const { loadQuickJs } = await import("./runtime");
      try {
        const { wasm, engine } = await loadQuickJs();
        const ctx = wasm.newContext();
        try {
          const out = ctx.unwrapResult(ctx.evalCode("1 + 1"));
          const value = ctx.getNumber(out);
          out.dispose();
          // Logged so it also surfaces in the Tauri dev console, where the
          // badge is not readable from outside the WebView.
          console.info(`[extensions] VM self test: engine=${engine} value=${value}`);
          if (!cancelled) {
            setResult({
              engine,
              ok: value === 2,
              detail: value === 2 ? "VM evaluated 1 + 1 = 2" : `unexpected value ${value}`,
            });
          }
        } finally {
          ctx.dispose();
        }
      } catch (err) {
        console.error("[extensions] VM self test failed", err);
        if (!cancelled) {
          setResult({
            engine: "none",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return result;
}

/** Small dev-only badge showing which engine the VM is running on. */
export function VmSelfTestBadge() {
  // Also enabled for the E2E build, which is compiled in release mode and so
  // would otherwise skip the badge entirely - and a skipped self test that
  // silently passes is worse than no test at all.
  const enabled = useMemo(() => import.meta.env.DEV || __E2E__, []);
  const result = useVmSelfTest(enabled);
  if (!enabled) return null;

  return (
    <div
      data-testid="vm-self-test"
      data-engine={result?.engine ?? "pending"}
      data-ok={result ? String(result.ok) : "pending"}
      className="pointer-events-none fixed bottom-2 left-2 z-50 rounded bg-[var(--item-hover-bg)] px-2 py-1 font-mono text-[10px] text-[var(--text-tertiary)]"
    >
      vm: {result ? `${result.engine} ${result.ok ? "ok" : `FAIL ${result.detail}`}` : "…"}
    </div>
  );
}
