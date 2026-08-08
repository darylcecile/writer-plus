/**
 * Owns the running extension runtime for the window.
 *
 * One runtime per window, created lazily the first time an extension panel is
 * opened. Lazily because starting QuickJS, loading every bundle, and spawning a
 * VM per extension is real work that a user who never opens an extension should
 * not pay for on launch.
 *
 * This is also where runtime permission prompts surface. They are queued rather
 * than rendered concurrently: several extensions asking at once would stack
 * dialogs on top of each other, and a user cannot meaningfully consent to a
 * question they are reading through another question.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { HostTree } from "@writer/extension-api/protocol";
import { type ExtensionRuntime, type InstalledExtension, type PermissionChoice } from "./runtime";
import { ExtensionPermissionPrompt, type PermissionRequest } from "./extension-permission-prompt";

interface PendingPrompt {
  request: PermissionRequest;
  resolve: (choice: PermissionChoice) => void;
}

export interface ExtensionHostState {
  runtime: ExtensionRuntime | null;
  extensions: InstalledExtension[];
  trees: Map<string, HostTree>;
  errors: Map<string, { message: string; fatal: boolean }>;
  loadError: string | null;
  loading: boolean;
  /** Rendered by the caller; `null` when nothing is waiting on the user. */
  prompt: React.ReactNode;
}

/**
 * Start the runtime once and keep it for the life of the window.
 *
 * @param enabled Gate so the runtime is not built until something needs it.
 */
export function useExtensionHost(enabled: boolean): ExtensionHostState {
  const [runtime, setRuntime] = useState<ExtensionRuntime | null>(null);
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const [trees, setTrees] = useState(() => new Map<string, HostTree>());
  const [errors, setErrors] = useState(
    () => new Map<string, { message: string; fatal: boolean }>(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [queue, setQueue] = useState<PendingPrompt[]>([]);

  // Names are needed inside the approval callback, which must not be rebuilt
  // when they arrive - the broker captures it once at construction.
  const namesRef = useRef(new Map<string, string>());

  const requestApproval = useCallback(
    (extensionId: string, permissionKey: string) =>
      new Promise<PermissionChoice>((resolve) => {
        setQueue((current) => [
          ...current,
          {
            request: {
              extensionId,
              extensionName: namesRef.current.get(extensionId) ?? extensionId,
              permissionKey,
            },
            resolve,
          },
        ]);
      }),
    [],
  );

  const startedRef = useRef(false);
  useEffect(() => {
    if (!enabled || startedRef.current) return;
    startedRef.current = true;

    let disposed = false;
    setLoading(true);

    void (async () => {
      try {
        const installed = await invoke<InstalledExtension[]>("extension_runtime_list");
        if (disposed) return;

        for (const ext of installed) namesRef.current.set(ext.id, ext.name);
        setExtensions(installed);

        // Loaded here rather than at module scope so QuickJS's WASM stays out
        // of the launch bundle. A user who never opens an extension should not
        // pay for the VM; a static import would put it in the main chunk,
        // because this hook is mounted by the app layout.
        const { createRuntime } = await import("./runtime");
        const created = await createRuntime(installed, {
          onTree: (instanceId, tree) => {
            setTrees((current) => new Map(current).set(instanceId, tree));
          },
          onError: (instanceId, message, fatal) => {
            setErrors((current) => new Map(current).set(instanceId, { message, fatal }));
          },
          onToast: (style, title, message) => {
            // Extensions get the console until Writer has a toast surface of
            // its own. Dropping them silently would make an extension's only
            // way of reporting a problem disappear.
            console.info(`[ext toast:${style}] ${title}${message ? ` - ${message}` : ""}`);
          },
          requestApproval,
        });

        if (disposed) {
          created.manager.disposeAll();
          return;
        }
        setRuntime(created);
      } catch (err) {
        // A runtime that failed to start must say so. Rendering an empty panel
        // would read as "you have no extensions", which is a different and
        // much less actionable problem.
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [enabled, requestApproval]);

  // Tear the VMs down when the window goes away. A VM holds a WASM heap and,
  // for unsafe extensions, child processes; neither is reclaimed by React.
  useEffect(() => {
    if (!runtime) return;
    return () => {
      runtime.manager.disposeAll();
    };
  }, [runtime]);

  const decide = useCallback((choice: PermissionChoice) => {
    setQueue((current) => {
      const [head, ...rest] = current;
      head?.resolve(choice);
      return rest;
    });
  }, []);

  const prompt = useMemo(() => {
    const head = queue[0];
    if (!head) return null;
    return (
      <ExtensionPermissionPrompt
        // Keyed so moving to the next question remounts rather than reusing
        // the previous one's fetched description.
        key={`${head.request.extensionId}:${head.request.permissionKey}`}
        request={head.request}
        onDecide={decide}
      />
    );
  }, [queue, decide]);

  return { runtime, extensions, trees, errors, loadError, loading, prompt };
}
