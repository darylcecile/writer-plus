/**
 * Host renderers for extension UI.
 *
 * An extension never ships markup. It commits a JSON tree of primitive names,
 * and this registry decides what each one actually looks like using Writer's
 * own theme tokens. That indirection is the whole point of the Raycast-style
 * model: an extension cannot pass a className, inject a style, or emit raw
 * HTML, so it cannot break the theme and cannot use the UI layer as an attack
 * surface.
 *
 * Adding a primitive means adding it here AND to the guest component library.
 * A type with no renderer is reported rather than silently skipped, because a
 * blank panel is far harder to diagnose than an explicit "unknown component".
 */

import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { HostNode, JsonValue } from "@writer/extension-api/protocol";

/** Invokes a guest callback by id. Supplied by whatever hosts the tree. */
export type EventDispatch = (handlerId: string, args: JsonValue[]) => void;

interface RenderContext {
  dispatch: EventDispatch;
}

type Renderer = (node: HostNode, ctx: RenderContext) => ReactNode;

// ------------------------------------------------------------------ helpers

const str = (v: JsonValue | undefined, fallback = ""): string =>
  typeof v === "string" ? v : fallback;
const bool = (v: JsonValue | undefined): boolean => v === true;

const childrenOfType = (node: HostNode, type: string): HostNode[] =>
  node.children.filter((c) => c.type === type);

const childrenExcept = (node: HostNode, types: string[]): HostNode[] =>
  node.children.filter((c) => !types.includes(c.type));

function renderAll(nodes: HostNode[], ctx: RenderContext): ReactNode {
  return nodes.map((child) => <RenderNode key={child.id} node={child} ctx={ctx} />);
}

/**
 * Bind a guest handler to a DOM event. Returns undefined when the guest did
 * not supply one, so React omits the listener rather than attaching a no-op.
 */
function handler(node: HostNode, name: string, ctx: RenderContext) {
  const id = node.handlers[name];
  if (!id) return undefined;
  return () => ctx.dispatch(id, []);
}

// ---------------------------------------------------------------------- List

function ListRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onSearch = node.handlers.onSearchTextChange;
  const accessory = childrenOfType(node, "List.Dropdown")[0];
  const empty = childrenOfType(node, "List.EmptyView")[0];
  const items = childrenExcept(node, ["List.Dropdown", "List.EmptyView"]);
  const hasItems = items.some((i) => i.type !== "#text");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2">
        {/* Uncontrolled: the guest lives across an async boundary, so echoing
            each keystroke through the VM would drop characters whenever a
            commit landed mid-typing. */}
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          placeholder={str(node.props.searchBarPlaceholder, "Search…")}
          onChange={onSearch ? (e) => ctx.dispatch(onSearch, [e.target.value]) : undefined}
        />
        {accessory ? <RenderNode node={accessory} ctx={ctx} /> : null}
      </div>

      {bool(node.props.isLoading) ? (
        <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">Loading…</div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {hasItems ? renderAll(items, ctx) : empty ? <RenderNode node={empty} ctx={ctx} /> : null}
      </div>
    </div>
  );
}

function ListItemRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const actions = childrenOfType(node, "ActionPanel")[0];
  const primary = actions ? findFirstAction(actions) : undefined;

  return (
    <div
      className="mx-1 flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--item-hover-bg)]"
      onClick={primary ? () => ctx.dispatch(primary.handlers.onAction, []) : undefined}
    >
      <span className="truncate text-[var(--text-primary)]">{str(node.props.title)}</span>
      {node.props.subtitle ? (
        <span className="truncate text-[11px] text-[var(--text-muted)]">
          {str(node.props.subtitle)}
        </span>
      ) : null}
      <span className="flex-1" />
      {node.props.accessoryTitle ? (
        <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
          {str(node.props.accessoryTitle)}
        </span>
      ) : null}
      {actions ? <RenderNode node={actions} ctx={ctx} /> : null}
    </div>
  );
}

/** The first Action carrying a handler, used as an item's default activation. */
function findFirstAction(
  panel: HostNode,
): (HostNode & { handlers: { onAction: string } }) | undefined {
  for (const child of panel.children) {
    if (child.type === "Action" && child.handlers.onAction) {
      return child as HostNode & { handlers: { onAction: string } };
    }
    if (child.type === "ActionPanel.Section") {
      const nested = findFirstAction(child);
      if (nested) return nested;
    }
  }
  return undefined;
}

// -------------------------------------------------------------------- Detail

function DetailRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const metadata = childrenOfType(node, "Detail.Metadata")[0];
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      {/* Rendered as text, never as HTML. Treating guest markdown as markup
          would hand every extension script injection into the host document,
          which is the one place the VM boundary cannot protect. */}
      <div className="text-[13px] whitespace-pre-wrap text-[var(--text-primary)]">
        {str(node.props.markdown)}
      </div>
      {metadata ? <RenderNode node={metadata} ctx={ctx} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------- Form

function FormRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const actions = childrenOfType(node, "ActionPanel")[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        {renderAll(childrenExcept(node, ["ActionPanel"]), ctx)}
      </div>
      {actions ? (
        <div className="flex justify-end gap-2 border-t border-[var(--line-subtle)] px-4 py-2">
          <RenderNode node={actions} ctx={ctx} />
        </div>
      ) : null}
    </div>
  );
}

function TextFieldRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onChange = node.handlers.onChange;
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-[var(--text-secondary)]">
        {str(node.props.title)}
      </span>
      <input
        className="w-full rounded-lg border border-[var(--surface-border)] bg-[var(--surface-input)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
        placeholder={str(node.props.placeholder)}
        defaultValue={str(node.props.defaultValue)}
        onChange={onChange ? (e) => ctx.dispatch(onChange, [e.target.value]) : undefined}
      />
    </label>
  );
}

function TextAreaRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onChange = node.handlers.onChange;
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-[var(--text-secondary)]">
        {str(node.props.title)}
      </span>
      <textarea
        className="min-h-24 w-full rounded-lg border border-[var(--surface-border)] bg-[var(--surface-input)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
        placeholder={str(node.props.placeholder)}
        defaultValue={str(node.props.defaultValue)}
        onChange={onChange ? (e) => ctx.dispatch(onChange, [e.target.value]) : undefined}
      />
    </label>
  );
}

function DropdownRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onChange = node.handlers.onChange;
  const items = node.children.filter((c) => c.type.endsWith("Dropdown.Item"));
  return (
    <select
      className="rounded-lg border border-[var(--surface-border)] bg-[var(--surface-input)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none"
      defaultValue={str(node.props.defaultValue)}
      onChange={onChange ? (e) => ctx.dispatch(onChange, [e.target.value]) : undefined}
    >
      {items.map((item) => (
        <option key={item.id} value={str(item.props.value)}>
          {str(item.props.title)}
        </option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------------- Actions

/**
 * Actions collapse into a menu so a long panel cannot push an item's own
 * content out of view.
 */
function ActionPanelRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const [open, setOpen] = useState(false);
  const actions = useMemo(() => flattenActions(node), [node]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((v) => !v);
  }, []);

  if (actions.length === 0) return null;

  return (
    <span className="relative">
      <button
        className="rounded px-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        onClick={toggle}
        aria-label="Actions"
      >
        ⌄
      </button>
      {open ? (
        <span className="absolute right-0 z-10 mt-1 flex min-w-40 flex-col rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-elevated)] py-1 shadow-lg">
          {actions.map((action) => (
            <button
              key={action.id}
              className="px-3 py-1 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                const id = action.handlers.onAction;
                if (id) ctx.dispatch(id, []);
              }}
            >
              {str(action.props.title)}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function flattenActions(node: HostNode): HostNode[] {
  const out: HostNode[] = [];
  for (const child of node.children) {
    if (child.type === "Action") out.push(child);
    else if (child.type === "ActionPanel.Section") out.push(...flattenActions(child));
  }
  return out;
}

// ---------------------------------------------------------------------- Chat

function ChatRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onSubmit = node.handlers.onSubmit;
  const [draft, setDraft] = useState("");
  const busy = bool(node.props.isLoading);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !onSubmit) return;
    ctx.dispatch(onSubmit, [text]);
    setDraft("");
  }, [draft, onSubmit, ctx]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {renderAll(node.children, ctx)}
      </div>
      <div className="flex items-end gap-2 border-t border-[var(--line-subtle)] p-2">
        <textarea
          className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-[var(--surface-border)] bg-[var(--surface-input)] px-2 py-1.5 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
          placeholder={str(node.props.placeholder, "Ask about your notes…")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="rounded-lg bg-[var(--surface-subtle)] px-3 py-1.5 text-[12px] text-[var(--text-primary)] disabled:text-[var(--text-muted)]"
          onClick={send}
          disabled={busy || draft.trim().length === 0}
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}

function ChatMessageRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const isUser = str(node.props.role, "assistant") === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-lg bg-[var(--surface-subtle)] px-3 py-2 text-[13px] whitespace-pre-wrap text-[var(--text-primary)]"
            : "max-w-[85%] text-[13px] whitespace-pre-wrap text-[var(--text-primary)]"
        }
      >
        {str(node.props.content)}
        {node.children.length > 0 ? (
          <div className="mt-2 space-y-1">{renderAll(node.children, ctx)}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A citation back into the user's own notes. Surfacing the source is what
 * makes a generated answer checkable instead of something taken on trust.
 */
function ChatSourceRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onOpen = handler(node, "onOpen", ctx);
  return (
    <button
      className="block w-full truncate rounded border border-[var(--line-subtle)] px-2 py-1 text-left text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      onClick={onOpen}
      disabled={!onOpen}
    >
      {str(node.props.title, str(node.props.path))}
    </button>
  );
}

// ----------------------------------------------------------------- structural

function SectionRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  return (
    <div className="py-1">
      {node.props.title ? (
        <div className="px-3 py-1 text-[10px] tracking-wide text-[var(--text-muted)] uppercase">
          {str(node.props.title)}
        </div>
      ) : null}
      {renderAll(node.children, ctx)}
    </div>
  );
}

function EmptyViewRenderer(node: HostNode): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-[13px] text-[var(--text-muted)]">
      <span className="text-[var(--text-primary)]">{str(node.props.title, "Nothing here")}</span>
      {node.props.description ? (
        <span className="text-[11px]">{str(node.props.description)}</span>
      ) : null}
    </div>
  );
}

function MetadataRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  return (
    <div className="mt-4 space-y-1 border-t border-[var(--line-subtle)] pt-3">
      {renderAll(node.children, ctx)}
    </div>
  );
}

function MetadataLabelRenderer(node: HostNode): ReactNode {
  return (
    <div className="flex justify-between gap-3 text-[11px]">
      <span className="text-[var(--text-muted)]">{str(node.props.title)}</span>
      <span className="truncate text-[var(--text-primary)]">{str(node.props.text)}</span>
    </div>
  );
}

function TextRenderer(node: HostNode): ReactNode {
  return <>{str(node.props.text)}</>;
}

// -------------------------------------------------------------------- registry

export const RENDERERS: Record<string, Renderer> = {
  "#text": TextRenderer,

  List: ListRenderer,
  "List.Item": ListItemRenderer,
  "List.Section": SectionRenderer,
  "List.EmptyView": EmptyViewRenderer,
  "List.Dropdown": DropdownRenderer,

  Detail: DetailRenderer,
  "Detail.Metadata": MetadataRenderer,
  "Detail.Metadata.Label": MetadataLabelRenderer,

  Form: FormRenderer,
  "Form.TextField": TextFieldRenderer,
  "Form.TextArea": TextAreaRenderer,
  "Form.Dropdown": DropdownRenderer,

  ActionPanel: ActionPanelRenderer,
  "ActionPanel.Section": SectionRenderer,
  // Action never renders standalone; ActionPanel owns its presentation.
  Action: () => null,

  Chat: ChatRenderer,
  "Chat.Message": ChatMessageRenderer,
  "Chat.Source": ChatSourceRenderer,
};

export function RenderNode({ node, ctx }: { node: HostNode; ctx: RenderContext }): ReactNode {
  const renderer = RENDERERS[node.type];
  if (!renderer) {
    // Explicit, because a silently dropped node shows up as an unexplained
    // blank area and is disproportionately hard to trace back to its cause.
    return (
      <div className="px-3 py-1 text-[11px] text-[var(--accent)]">
        Unknown component <code>{node.type}</code>
      </div>
    );
  }
  return <>{renderer(node, ctx)}</>;
}

/** Render a committed tree. The single entry point for extension UI. */
export function ExtensionTree({
  root,
  dispatch,
}: {
  root: HostNode[];
  dispatch: EventDispatch;
}): ReactNode {
  const ctx = useMemo(() => ({ dispatch }), [dispatch]);
  return <>{renderAll(root, ctx)}</>;
}
