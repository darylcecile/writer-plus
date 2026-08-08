/**
 * The right-hand dock that hosts extension panels.
 *
 * Renders nothing at all until an extension is opened, and the runtime is not
 * even constructed until then - starting a VM per installed extension is real
 * work that a user who never opens one should not pay for.
 *
 * The permission prompt is rendered here rather than beside the panel because
 * it must stay visible even if the extension's own tree is broken or empty. A
 * consent dialog that depends on the extension rendering correctly is a consent
 * dialog a broken extension can suppress.
 */

import { useUIStore } from "@/stores/ui-store";
import { ExtensionPanel } from "./extension-panel";
import { useExtensionHost } from "./use-extension-host";

export function ExtensionDock() {
  const openPanel = useUIStore((state) => state.openExtensionPanel);
  const setExtensionPanel = useUIStore((state) => state.setExtensionPanel);
  const host = useExtensionHost(openPanel !== null);

  if (!openPanel) return null;

  const [extensionId, command] = splitPanelId(openPanel);
  const extension = host.extensions.find((ext) => ext.id === extensionId);

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-[var(--line-subtle)] bg-bg">
      <header className="flex items-center justify-between px-3 py-2 pt-[calc(var(--chrome-drag-height)+4px)]">
        <span className="truncate text-xs font-medium text-[var(--text-secondary)]">
          {extension?.name ?? extensionId}
        </span>
        <button
          type="button"
          aria-label="Close extension panel"
          className="rounded px-1.5 py-0.5 text-xs text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)]"
          onClick={() => setExtensionPanel(null)}
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <DockBody host={host} extensionId={extensionId} command={command} />
      </div>

      {host.prompt && <div className="border-t border-[var(--line-subtle)] p-3">{host.prompt}</div>}
    </aside>
  );
}

function DockBody({
  host,
  extensionId,
  command,
}: {
  host: ReturnType<typeof useExtensionHost>;
  extensionId: string;
  command: string;
}) {
  if (host.loadError) {
    return <Message title="Extensions could not start">{host.loadError}</Message>;
  }
  if (host.loading || !host.runtime) {
    return <Message title="Starting…">Loading the extension sandbox.</Message>;
  }

  const installed = host.extensions.some((ext) => ext.id === extensionId);
  if (!installed) {
    return (
      <Message title="Not installed">
        {extensionId} is not installed, or was removed while its panel was open.
      </Message>
    );
  }

  return (
    <ExtensionPanel
      manager={host.runtime.manager}
      instanceId={extensionId}
      command={command}
      tree={host.trees.get(extensionId)}
      error={host.errors.get(extensionId)}
    />
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4">
      <p className="text-sm text-[var(--text-secondary)]">{title}</p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{children}</p>
    </div>
  );
}

/**
 * Split `extensionId:command`.
 *
 * Extension ids may contain dots but not colons (the manifest validator
 * enforces that), so the first colon is an unambiguous separator.
 */
export function splitPanelId(panelId: string): [extensionId: string, command: string] {
  const colon = panelId.indexOf(":");
  if (colon === -1) return [panelId, "main"];
  return [panelId.slice(0, colon), panelId.slice(colon + 1)];
}
