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
 * `renderers.test.tsx` fails if the two ever disagree, in either direction. A
 * component the guest can name but the host cannot draw vanishes from the panel
 * with nothing explaining why, and that drift is exactly what shipped before
 * the test existed: 25 of 42 declared components rendered nothing.
 *
 * A type with no renderer is reported rather than silently skipped, because a
 * blank panel is far harder to diagnose than an explicit "unknown component".
 */

import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Accessory, Color, Icon } from "@writer/extension-api";
import type { HostNode, JsonValue } from "@writer/extension-api/protocol";
import { ExtensionIcon } from "./icons";

/** Invokes a guest callback by id. Supplied by whatever hosts the tree. */
export type EventDispatch = (handlerId: string, args: JsonValue[]) => void;

/**
 * Effects the host performs itself on an extension's behalf.
 *
 * These exist so the commonest actions - open this note, copy this text - do
 * not force every extension to hold `workspace.read` or `clipboard.write` just
 * to offer a menu item. The host does the work with the user's own authority,
 * so the extension gains nothing it could misuse: it never sees the file, and
 * it cannot observe whether the effect succeeded.
 */
export interface HostEffects {
  openNote: (path: string) => void;
  copyToClipboard: (text: string) => void;
  openInBrowser: (url: string) => void;
  /** Pushes a subtree onto the panel's navigation stack. */
  push: (title: string, node: HostNode) => void;
  pop: () => void;
}

interface RenderContext {
  dispatch: EventDispatch;
  effects: HostEffects;
  /** Current field values, keyed by field id, for Action.SubmitForm. */
  formValues: Map<string, JsonValue>;
}

type Renderer = (node: HostNode, ctx: RenderContext) => ReactNode;

// ------------------------------------------------------------------ helpers

const str = (v: JsonValue | undefined, fallback = ""): string =>
  typeof v === "string" ? v : fallback;
const bool = (v: JsonValue | undefined): boolean => v === true;
const num = (v: JsonValue | undefined, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

const icon = (v: JsonValue | undefined): Icon | undefined =>
  typeof v === "string" ? (v as Icon) : undefined;

const color = (v: JsonValue | undefined): Color | undefined =>
  typeof v === "string" ? (v as Color) : undefined;

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

/**
 * Records a field's current value so `Action.SubmitForm` can collect them.
 *
 * A plain Map rather than React state: the inputs below are uncontrolled on
 * purpose, and re-rendering the form on every keystroke would fight that. The
 * value is only ever read when an action fires.
 */
function trackField(ctx: RenderContext, node: HostNode, value: JsonValue): void {
  const id = str(node.props.id);
  if (id) ctx.formValues.set(id, value);
}

/** A field's starting value, also seeded into the submit map. */
/**
 * Seeds a field from the extension's declared default and registers it so
 * `Action.SubmitForm` can read it back.
 *
 * The return type is deliberately `JsonValue` and not the fallback's type. The
 * declared value arrives as untrusted JSON, so a signature that inferred
 * `false` from a `false` fallback would be asserting something about the guest
 * that nothing checks - and a checkbox handed `defaultValue: "yes"` would be
 * typed as a boolean it is not. Callers coerce, visibly.
 */
function initialField(ctx: RenderContext, node: HostNode, fallback: JsonValue): JsonValue {
  const declared = node.props.defaultValue ?? node.props.value;
  const value = declared === undefined ? fallback : declared;
  trackField(ctx, node, value);
  return value;
}

const INPUT_CLASS =
  "w-full rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-input)] px-2 py-1 text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]";

/** Shared label and validation chrome, so every field reports errors the same way. */
function Field({ node, children }: { node: HostNode; children: ReactNode }) {
  const error = str(node.props.error);
  const info = str(node.props.info);
  return (
    <label className="block">
      {node.props.title ? (
        <span className="mb-1 block text-[11px] text-[var(--text-secondary)]">
          {str(node.props.title)}
        </span>
      ) : null}
      {children}
      {/* Error wins over info: when a field is already wrong, the hint that
          failed to prevent it is not the thing to keep on screen. */}
      {error ? (
        <span className="mt-1 block text-[11px] text-[var(--danger)]">{error}</span>
      ) : info ? (
        <span className="mt-1 block text-[11px] text-[var(--text-muted)]">{info}</span>
      ) : null}
    </label>
  );
}

// ---------------------------------------------------------------------- List

function ListRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onSearch = node.handlers.onSearchTextChange;
  const accessory = childrenOfType(node, "List.Dropdown")[0];
  const empty = childrenOfType(node, "List.EmptyView")[0];
  const actions = childrenOfType(node, "ActionPanel")[0];
  const items = childrenExcept(node, ["List.Dropdown", "List.EmptyView", "ActionPanel"]);
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
        {/* The accessory is boxed to a fixed share of the row. Its `<select>`
            is `w-full`, which as a bare flex child resolves against the whole
            header and squeezes the search field to zero width - a search box
            that is present, focusable by keyboard, and completely invisible. */}
        {accessory ? (
          <div className="w-32 shrink-0">
            <RenderNode node={accessory} ctx={ctx} />
          </div>
        ) : null}
        {actions ? <RenderNode node={actions} ctx={ctx} /> : null}
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

/**
 * Accessories are data, not elements: an extension names a tag or a piece of
 * text and the host decides how it looks, same as icons.
 */
function accessoriesOf(node: HostNode): Accessory[] {
  const raw = node.props.accessories;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is Accessory & JsonValue => typeof a === "object" && a !== null);
}

function AccessoryView({ accessory }: { accessory: Accessory }) {
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-[11px] text-[var(--text-muted)]"
      title={accessory.tooltip}
    >
      {accessory.icon ? <ExtensionIcon name={accessory.icon} size={12} color="muted" /> : null}
      {accessory.tag ? (
        <span className="rounded border border-[var(--line-subtle)] px-1 py-px">
          {accessory.tag}
        </span>
      ) : null}
      {accessory.text ? <span>{accessory.text}</span> : null}
    </span>
  );
}

function ListItemRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const actions = childrenOfType(node, "ActionPanel")[0];
  const primary = actions ? findFirstAction(actions) : undefined;
  const accessories = accessoriesOf(node);

  return (
    <div
      className="mx-1 flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--item-hover-bg)]"
      onClick={primary ? () => runAction(primary, ctx) : undefined}
    >
      {node.props.icon ? <ExtensionIcon name={icon(node.props.icon)} /> : null}
      <span className="truncate text-[var(--text-primary)]">{str(node.props.title)}</span>
      {node.props.subtitle ? (
        <span className="truncate text-[11px] text-[var(--text-muted)]">
          {str(node.props.subtitle)}
        </span>
      ) : null}
      <span className="flex-1" />
      {accessories.map((accessory, index) => (
        // Accessories have no identity of their own and are a short positional
        // list, so the index is the only stable key available.
        // eslint-disable-next-line react/no-array-index-key
        <AccessoryView key={index} accessory={accessory} />
      ))}
      {actions ? <RenderNode node={actions} ctx={ctx} /> : null}
    </div>
  );
}

/** The first action that would actually do something, used as default activation. */
function findFirstAction(panel: HostNode): HostNode | undefined {
  for (const child of panel.children) {
    if (isActionType(child.type) && isActionable(child)) return child;
    if (child.type === "ActionPanel.Section" || child.type === "ActionPanel.Submenu") {
      const nested = findFirstAction(child);
      if (nested) return nested;
    }
  }
  return undefined;
}

// -------------------------------------------------------------------- Detail

function DetailRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const metadata = childrenOfType(node, "Detail.Metadata")[0];
  const actions = childrenOfType(node, "ActionPanel")[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {bool(node.props.isLoading) ? (
          <div className="pb-2 text-[11px] text-[var(--text-muted)]">Loading…</div>
        ) : null}
        {/* Rendered as text, never as HTML. Treating guest markdown as markup
            would hand every extension script injection into the host document,
            which is the one place the VM boundary cannot protect. */}
        <div className="text-[13px] whitespace-pre-wrap text-[var(--text-primary)]">
          {str(node.props.markdown)}
        </div>
        {metadata ? <RenderNode node={metadata} ctx={ctx} /> : null}
      </div>
      {actions ? (
        <div className="flex justify-end border-t border-[var(--line-subtle)] px-4 py-2">
          <RenderNode node={actions} ctx={ctx} />
        </div>
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
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="flex items-center gap-1 text-[var(--text-muted)]">
        {node.props.icon ? (
          <ExtensionIcon name={icon(node.props.icon)} size={12} color="muted" />
        ) : null}
        {str(node.props.title)}
      </span>
      <span className="truncate text-[var(--text-primary)]">{str(node.props.text)}</span>
    </div>
  );
}

/**
 * A metadata link opens in the user's browser via the host, so the extension
 * needs no network capability and the destination is visible before it is
 * followed.
 */
function MetadataLinkRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const target = str(node.props.target);
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="text-[var(--text-muted)]">{str(node.props.title)}</span>
      <button
        type="button"
        className="truncate text-[var(--accent)] hover:underline"
        title={target}
        onClick={() => ctx.effects.openInBrowser(target)}
      >
        {str(node.props.text, target)}
      </button>
    </div>
  );
}

function MetadataSeparatorRenderer(): ReactNode {
  return <div className="my-2 border-t border-[var(--line-subtle)]" />;
}

function MetadataTagListRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  return (
    <div className="flex items-start justify-between gap-3 text-[11px]">
      <span className="shrink-0 text-[var(--text-muted)]">{str(node.props.title)}</span>
      <span className="flex flex-wrap justify-end gap-1">{renderAll(node.children, ctx)}</span>
    </div>
  );
}

function MetadataTagRenderer(node: HostNode): ReactNode {
  const tone = color(node.props.color) ?? "default";
  return (
    <span className="flex items-center gap-1 rounded border border-[var(--line-subtle)] px-1.5 py-px text-[var(--text-primary)]">
      {tone === "default" ? null : <ExtensionIcon name="tag" size={10} color={tone} />}
      {str(node.props.text)}
    </span>
  );
}

// ---------------------------------------------------------------------- Form

function FormRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const actions = childrenOfType(node, "ActionPanel")[0];
  return (
    <div className="flex h-full min-h-0 flex-col">
      {bool(node.props.isLoading) ? (
        <div className="px-4 pt-3 text-[11px] text-[var(--text-muted)]">Loading…</div>
      ) : null}
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
  const onBlur = handler(node, "onBlur", ctx);
  const initial = str(initialField(ctx, node, ""));
  return (
    <Field node={node}>
      <input
        className={INPUT_CLASS}
        placeholder={str(node.props.placeholder)}
        defaultValue={initial}
        autoFocus={bool(node.props.autoFocus)}
        onBlur={onBlur}
        onChange={(e) => {
          trackField(ctx, node, e.target.value);
          if (onChange) ctx.dispatch(onChange, [e.target.value]);
        }}
      />
    </Field>
  );
}

function PasswordFieldRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onChange = node.handlers.onChange;
  const onBlur = handler(node, "onBlur", ctx);
  // Deliberately not seeded from defaultValue. A pre-filled secret is one the
  // extension already had, and rendering it back invites the user to read it as
  // something the host vouched for.
  trackField(ctx, node, "");
  return (
    <Field node={node}>
      <input
        type="password"
        className={INPUT_CLASS}
        placeholder={str(node.props.placeholder)}
        autoFocus={bool(node.props.autoFocus)}
        onBlur={onBlur}
        onChange={(e) => {
          trackField(ctx, node, e.target.value);
          if (onChange) ctx.dispatch(onChange, [e.target.value]);
        }}
      />
    </Field>
  );
}

function TextAreaRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onChange = node.handlers.onChange;
  const onBlur = handler(node, "onBlur", ctx);
  const initial = str(initialField(ctx, node, ""));
  return (
    <Field node={node}>
      <textarea
        className={`min-h-24 ${INPUT_CLASS}`}
        placeholder={str(node.props.placeholder)}
        defaultValue={initial}
        autoFocus={bool(node.props.autoFocus)}
        onBlur={onBlur}
        onChange={(e) => {
          trackField(ctx, node, e.target.value);
          if (onChange) ctx.dispatch(onChange, [e.target.value]);
        }}
      />
    </Field>
  );
}

function CheckboxRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onChange = node.handlers.onChange;
  const initial = initialField(ctx, node, false) === true;
  return (
    <Field node={node}>
      <span className="flex items-center gap-2">
        <input
          type="checkbox"
          className="accent-[var(--accent)]"
          defaultChecked={initial}
          onChange={(e) => {
            trackField(ctx, node, e.target.checked);
            if (onChange) ctx.dispatch(onChange, [e.target.checked]);
          }}
        />
        <span className="text-[13px] text-[var(--text-primary)]">{str(node.props.label)}</span>
      </span>
    </Field>
  );
}

/**
 * Dropdown options are read directly rather than through the registry, because
 * `<option>` cannot contain arbitrary markup and the host owns the select's
 * internals. The item types still have renderers so a stray one outside a
 * dropdown draws something honest instead of "unknown component".
 */
function DropdownRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onChange = node.handlers.onChange;
  const initial = str(initialField(ctx, node, ""));
  const select = (
    <select
      className="w-full rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-input)] px-2 py-1 text-[11px] text-[var(--text-primary)] outline-none"
      defaultValue={initial}
      title={str(node.props.tooltip)}
      onChange={(e) => {
        trackField(ctx, node, e.target.value);
        if (onChange) ctx.dispatch(onChange, [e.target.value]);
      }}
    >
      {node.props.placeholder ? (
        <option value="" disabled>
          {str(node.props.placeholder)}
        </option>
      ) : null}
      {dropdownGroups(node)}
    </select>
  );

  // A List.Dropdown is a search-bar accessory with no label of its own; a
  // Form.Dropdown is a field and gets the same chrome as its neighbours.
  return node.type === "Form.Dropdown" ? <Field node={node}>{select}</Field> : select;
}

function dropdownGroups(node: HostNode): ReactNode {
  return node.children.map((child) => {
    if (child.type.endsWith("Dropdown.Section")) {
      return (
        <optgroup key={child.id} label={str(child.props.title)}>
          {child.children.map(dropdownOption)}
        </optgroup>
      );
    }
    return dropdownOption(child);
  });
}

function dropdownOption(child: HostNode): ReactNode {
  if (!child.type.endsWith("Dropdown.Item")) return null;
  return (
    <option key={child.id} value={str(child.props.value)}>
      {str(child.props.title)}
    </option>
  );
}

/** A dropdown option encountered outside a dropdown. */
function DropdownItemRenderer(node: HostNode): ReactNode {
  return <span className="text-[11px] text-[var(--text-primary)]">{str(node.props.title)}</span>;
}

function TagPickerRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onChange = node.handlers.onChange;
  const declared = node.props.defaultValue ?? node.props.value;
  const initial = Array.isArray(declared) ? declared.map((v) => str(v)) : [];
  const [selected, setSelected] = useState<string[]>(initial);
  trackField(ctx, node, selected);

  const options = node.children.filter((c) => c.type.endsWith("TagPicker.Item"));

  const toggle = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    setSelected(next);
    trackField(ctx, node, next);
    if (onChange) ctx.dispatch(onChange, [next]);
  };

  return (
    <Field node={node}>
      <span className="flex flex-wrap gap-1">
        {options.length === 0 ? (
          <span className="text-[11px] text-[var(--text-muted)]">
            {str(node.props.placeholder, "No options")}
          </span>
        ) : null}
        {options.map((option) => {
          const value = str(option.props.value);
          const on = selected.includes(value);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={on}
              className={
                on
                  ? "rounded border border-[var(--accent)] px-1.5 py-px text-[11px] text-[var(--accent)]"
                  : "rounded border border-[var(--line-subtle)] px-1.5 py-px text-[11px] text-[var(--text-secondary)]"
              }
              onClick={() => toggle(value)}
            >
              {str(option.props.title, value)}
            </button>
          );
        })}
      </span>
    </Field>
  );
}

/** A tag option encountered outside a picker. */
function TagPickerItemRenderer(node: HostNode): ReactNode {
  return (
    <span className="rounded border border-[var(--line-subtle)] px-1.5 py-px text-[11px] text-[var(--text-secondary)]">
      {str(node.props.title, str(node.props.value))}
    </span>
  );
}

function DescriptionRenderer(node: HostNode): ReactNode {
  return (
    <div>
      {node.props.title ? (
        <div className="mb-1 text-[11px] text-[var(--text-secondary)]">{str(node.props.title)}</div>
      ) : null}
      <p className="text-[12px] whitespace-pre-wrap text-[var(--text-muted)]">
        {str(node.props.text)}
      </p>
    </div>
  );
}

function SeparatorRenderer(): ReactNode {
  return <div className="border-t border-[var(--line-subtle)]" />;
}

// ---------------------------------------------------------------------- Grid

function GridRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onSearch = node.handlers.onSearchTextChange;
  const empty = childrenOfType(node, "Grid.EmptyView")[0];
  const actions = childrenOfType(node, "ActionPanel")[0];
  const items = childrenExcept(node, ["Grid.EmptyView", "ActionPanel"]);
  const hasItems = items.some((i) => i.type !== "#text");
  // Clamped: an extension asking for 40 columns in a 360px dock produces
  // unreadable slivers, and there is no reason to let it.
  const columns = Math.min(Math.max(Math.round(num(node.props.columns, 3)), 1), 8);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-3 py-2">
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          placeholder={str(node.props.searchBarPlaceholder, "Search…")}
          onChange={onSearch ? (e) => ctx.dispatch(onSearch, [e.target.value]) : undefined}
        />
        {actions ? <RenderNode node={actions} ctx={ctx} /> : null}
      </div>
      {bool(node.props.isLoading) ? (
        <div className="px-3 py-2 text-[11px] text-[var(--text-muted)]">Loading…</div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {hasItems ? (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {renderAll(items, ctx)}
          </div>
        ) : empty ? (
          <RenderNode node={empty} ctx={ctx} />
        ) : null}
      </div>
    </div>
  );
}

function GridItemRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const actions = childrenOfType(node, "ActionPanel")[0];
  const primary = actions ? findFirstAction(actions) : undefined;
  return (
    <div
      className="flex cursor-default flex-col gap-1 rounded-lg border border-[var(--line-subtle)] p-2 hover:bg-[var(--item-hover-bg)]"
      onClick={primary ? () => runAction(primary, ctx) : undefined}
    >
      {/* `content` names an icon, never an image URL - the same closed
          vocabulary as every other icon, for the same reason. */}
      <span className="flex items-center justify-center py-3">
        <ExtensionIcon name={icon(node.props.content)} size={24} />
      </span>
      {node.props.title ? (
        <span className="truncate text-[12px] text-[var(--text-primary)]">
          {str(node.props.title)}
        </span>
      ) : null}
      {node.props.subtitle ? (
        <span className="truncate text-[11px] text-[var(--text-muted)]">
          {str(node.props.subtitle)}
        </span>
      ) : null}
    </div>
  );
}

/** Grid sections span the whole grid rather than sitting in one cell. */
function GridSectionRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  return (
    <div className="col-span-full">
      {node.props.title ? (
        <div className="px-1 py-1 text-[10px] tracking-wide text-[var(--text-muted)] uppercase">
          {str(node.props.title)}
        </div>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
        {renderAll(node.children, ctx)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- Actions

/** Every type that behaves as an action inside an ActionPanel. */
const ACTION_TYPES = new Set([
  "Action",
  "Action.OpenNote",
  "Action.CopyToClipboard",
  "Action.OpenInBrowser",
  "Action.SubmitForm",
  "Action.Push",
  "Action.Pop",
]);

const isActionType = (type: string): boolean => ACTION_TYPES.has(type);

/**
 * Whether an action would actually do anything if activated.
 *
 * An entry that does nothing when clicked is worse than a missing one: it reads
 * as the extension being broken rather than as the action being unavailable.
 */
function isActionable(node: HostNode): boolean {
  switch (node.type) {
    case "Action":
      return Boolean(node.handlers.onAction);
    case "Action.OpenNote":
      return Boolean(str(node.props.path));
    case "Action.CopyToClipboard":
      return typeof node.props.content === "string";
    case "Action.OpenInBrowser":
      return Boolean(str(node.props.url));
    case "Action.Push":
      return node.children.length > 0;
    case "Action.SubmitForm":
      return Boolean(node.handlers.onSubmit);
    case "Action.Pop":
      return true;
    default:
      return false;
  }
}

/** The default title for a built-in that did not supply one. */
const ACTION_TITLES: Record<string, string> = {
  "Action.OpenNote": "Open Note",
  "Action.CopyToClipboard": "Copy to Clipboard",
  "Action.OpenInBrowser": "Open in Browser",
  "Action.SubmitForm": "Submit",
  "Action.Pop": "Back",
};

function actionTitle(node: HostNode): string {
  return str(node.props.title, ACTION_TITLES[node.type] ?? "Action");
}

/**
 * Performs an action. Built-ins run in the host; a plain `Action` calls back
 * into the extension.
 */
function runAction(node: HostNode, ctx: RenderContext): void {
  switch (node.type) {
    case "Action.OpenNote":
      ctx.effects.openNote(str(node.props.path));
      return;
    case "Action.CopyToClipboard":
      ctx.effects.copyToClipboard(str(node.props.content));
      return;
    case "Action.OpenInBrowser":
      ctx.effects.openInBrowser(str(node.props.url));
      return;
    case "Action.SubmitForm": {
      const id = node.handlers.onSubmit;
      // Object.fromEntries, not the Map itself: the guest receives JSON, and a
      // Map sanitizes to an empty object rather than failing loudly.
      if (id) ctx.dispatch(id, [Object.fromEntries(ctx.formValues) as JsonValue]);
      return;
    }
    case "Action.Push": {
      const target = node.children[0];
      if (target) ctx.effects.push(actionTitle(node), target);
      return;
    }
    case "Action.Pop":
      ctx.effects.pop();
      return;
    default: {
      const id = node.handlers.onAction;
      if (id) ctx.dispatch(id, []);
    }
  }
}

/**
 * Actions collapse into a menu so a long panel cannot push an item's own
 * content out of view.
 */
function ActionPanelRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const [open, setOpen] = useState(false);
  // The panel is rendered in two very different places: inline on a list row,
  // where there is room below, and in the chat composer, which sits on the
  // bottom edge. A fixed `mt-1` menu is clipped in the second case, so the
  // direction is measured at open time rather than assumed.
  const [dropUp, setDropUp] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actions = useMemo(() => flattenActions(node), [node]);

  const toggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!open) {
        const rect = triggerRef.current?.getBoundingClientRect();
        // ~32px per row plus padding, capped so a long list still decides
        // sensibly rather than always flipping.
        const needed = Math.min(actions.length * 32 + 8, 240);
        setDropUp(rect ? window.innerHeight - rect.bottom < needed : false);
      }
      setOpen((v) => !v);
    },
    [open, actions.length],
  );

  if (actions.length === 0) return null;

  return (
    <span className="relative">
      <button
        ref={triggerRef}
        type="button"
        className="flex h-6 w-6 items-center justify-center rounded text-[11px] leading-none text-[var(--text-muted)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
        onClick={toggle}
        aria-label="Actions"
        aria-expanded={open}
      >
        ⌄
      </button>
      {open ? (
        // `surface-card` is the app's own floating-surface primitive: it carries
        // the blur plus an opaque under-layer, so the menu is legible over
        // whatever the extension rendered behind it. A plain background token
        // here was transparent, and the list rows read straight through the
        // open menu.
        <span
          className={`surface-card absolute right-0 z-10 flex min-w-40 flex-col py-1 shadow-lg ${
            dropUp ? "bottom-full mb-1" : "mt-1"
          }`}
        >
          {actions.map(({ node: action, group }) => (
            <button
              key={action.id}
              type="button"
              className={
                str(action.props.style) === "destructive"
                  ? "flex items-center gap-2 px-3 py-1 text-left text-[12px] text-[var(--danger)] hover:bg-[var(--item-hover-bg)]"
                  : "flex items-center gap-2 px-3 py-1 text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
              }
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                runAction(action, ctx);
              }}
            >
              {action.props.icon ? (
                <ExtensionIcon name={icon(action.props.icon)} size={12} />
              ) : null}
              <span className="flex-1 truncate">
                {/* Submenu membership is shown inline rather than as a nested
                    flyout: a second popover inside a 360px dock is a target
                    users miss, and the grouping is all it carried. */}
                {group ? `${group}: ${actionTitle(action)}` : actionTitle(action)}
              </span>
              {action.props.shortcut ? (
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                  {formatShortcut(action.props.shortcut)}
                </span>
              ) : null}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

const MODIFIER_SYMBOLS: Record<string, string> = {
  cmd: "⌘",
  ctrl: "⌃",
  shift: "⇧",
  opt: "⌥",
};

/**
 * A shortcut is displayed but not bound.
 *
 * Binding it would let any extension claim a chord the moment it is installed,
 * including one the app itself uses, and that needs a conflict story the system
 * does not have. Showing it is still worth doing, because the extension's own
 * documentation will mention it and a user who cannot find it will assume the
 * install is broken.
 */
export function formatShortcut(value: JsonValue): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const shortcut = value as { modifiers?: JsonValue; key?: JsonValue };
  const modifiers = Array.isArray(shortcut.modifiers) ? shortcut.modifiers : [];
  const rendered = modifiers.map((m) => MODIFIER_SYMBOLS[str(m)] ?? str(m)).join("");
  const key = str(shortcut.key);
  return key ? `${rendered}${key.toUpperCase()}` : rendered;
}

interface FlatAction {
  node: HostNode;
  /** The submenu this action came from, if any. */
  group?: string;
}

function flattenActions(node: HostNode, group?: string): FlatAction[] {
  const out: FlatAction[] = [];
  for (const child of node.children) {
    if (isActionType(child.type)) {
      if (isActionable(child)) out.push({ node: child, group });
    } else if (child.type === "ActionPanel.Section") {
      out.push(...flattenActions(child, group));
    } else if (child.type === "ActionPanel.Submenu") {
      out.push(...flattenActions(child, str(child.props.title) || group));
    }
  }
  return out;
}

// ---------------------------------------------------------------------- Chat

function ChatRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const onSubmit = node.handlers.onSubmit;
  const [draft, setDraft] = useState("");
  const busy = bool(node.props.isLoading);
  const disabled = bool(node.props.disabled);
  const actions = childrenOfType(node, "ActionPanel")[0];
  const messages = childrenExcept(node, ["ActionPanel"]);
  const hasMessages = messages.some((m) => m.type !== "#text");

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || !onSubmit) return;
    ctx.dispatch(onSubmit, [text]);
    setDraft("");
  }, [draft, onSubmit, ctx]);

  // A textarea's height is fixed by its `rows` attribute; it does not grow with
  // its content, it scrolls. So `max-h-32` alone described an auto-growing
  // composer that never actually grew - the input stayed one line tall and
  // hid everything the user had typed above the caret. Measuring against
  // `scrollHeight` is the only way to size it to its content; the CSS max-height
  // still caps it, and overflow takes over past that point.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // `scrollHeight` excludes the border but Tailwind sizes everything
    // `border-box`, so assigning it directly leaves the element 2px short of its
    // own content and it scrolls one line early.
    const cs = getComputedStyle(el);
    const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = `${el.scrollHeight + border}px`;
  }, [draft]);

  // Keep the newest message in view as a turn streams in. Anchored to the
  // transcript element rather than `scrollIntoView` on a child, which would
  // also scroll the app's own layout if the panel were ever nested.
  const transcriptRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={transcriptRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {hasMessages ? (
          renderAll(messages, ctx)
        ) : (
          <div className="flex flex-col items-center justify-center gap-1 py-10 text-center">
            <span className="text-[13px] text-[var(--text-primary)]">
              {str(node.props.emptyTitle, "Nothing here yet")}
            </span>
            {node.props.emptyDescription ? (
              <span className="text-[11px] text-[var(--text-muted)]">
                {str(node.props.emptyDescription)}
              </span>
            ) : null}
          </div>
        )}
      </div>
      {/* Actions live in the composer row rather than in a bar of their own.
          The ActionPanel trigger is a bare chevron - fine beside a list row it
          belongs to, but as a strip above the transcript it read as an empty
          toolbar with a stray glyph in it, which is exactly how it looked. */}
      <div className="flex items-end gap-1.5 border-t border-[var(--line-subtle)] p-2">
        <textarea
          ref={inputRef}
          // One row by default. Without this a textarea is two rows tall, so the
          // composer opened at 53px against a 36px `min-h-9` intent and nothing
          // beside it could line up.
          rows={1}
          // `py-[7px]`, not `py-2`: 20px line + 14px padding + 2px border is
          // exactly 36px, so a single-line input matches the `h-9` buttons
          // beside it rather than sitting 2px taller than them.
          className="max-h-32 min-h-9 flex-1 resize-none rounded-lg border border-[var(--line-subtle)] bg-[var(--surface-input)] px-2 py-[7px] text-[13px] leading-5 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] disabled:opacity-60"
          placeholder={str(node.props.placeholder, "Ask about your notes…")}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {actions ? (
          <div className="flex h-9 shrink-0 items-center">
            <RenderNode node={actions} ctx={ctx} />
          </div>
        ) : null}
        {/* Stop replaces Send while a turn is in flight rather than sitting
            beside it: they are never both useful, and the composer is narrow.
            Both are `h-9` so they match the input's resting height exactly -
            `items-end` then keeps them on the input's last line as it grows,
            instead of floating against a taller box. */}
        {busy && node.handlers.onStop ? (
          <button
            type="button"
            className="h-9 shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 text-[12px] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
            onClick={handler(node, "onStop", ctx)}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            // Accent-on-transparent rather than a filled button: it is the
            // affirmative action here, and this matches how the install and
            // consent dialogs mark theirs.
            className="h-9 shrink-0 rounded-lg border border-[var(--line-subtle)] px-3 text-[12px] text-[var(--text-muted)] enabled:border-[var(--accent)] enabled:text-[var(--accent)] enabled:hover:bg-[var(--item-hover-bg)]"
            onClick={send}
            disabled={busy || disabled || draft.trim().length === 0}
          >
            {busy ? "…" : "Send"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Citations are a data prop, not child elements.
 *
 * They describe notes the host already knows how to open, so making the guest
 * assemble elements for them would add a component whose only job is to be
 * turned back into a path. Rendering them here also makes a citation click a
 * host-performed open, so an extension can point at a note without holding
 * `workspace.read`.
 *
 * They were silently dropped before this: the prop was declared, the AI chat
 * extension passed it, and nothing read it - so every generated answer arrived
 * with no way to check where it came from.
 */
interface Citation {
  path: string;
  title?: string;
  excerpt?: string;
}

function citationsOf(node: HostNode): Citation[] {
  const raw = node.props.citations;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Citation & JsonValue => typeof c === "object" && c !== null)
    .filter((c) => typeof c.path === "string" && c.path.length > 0);
}

function ChatMessageRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const isUser = str(node.props.role, "assistant") === "user";
  const citations = citationsOf(node);

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
        {bool(node.props.streaming) ? (
          <span className="ml-0.5 text-[var(--text-muted)]">▍</span>
        ) : null}
        {citations.length > 0 ? (
          <div className="mt-2 space-y-1">
            {citations.map((citation) => (
              <button
                key={citation.path}
                type="button"
                title={citation.excerpt ?? citation.path}
                className="flex w-full items-center gap-1 truncate rounded border border-[var(--line-subtle)] px-2 py-1 text-left text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                onClick={() => ctx.effects.openNote(citation.path)}
              >
                <ExtensionIcon name="document" size={11} color="muted" />
                <span className="truncate">{citation.title || citation.path}</span>
              </button>
            ))}
          </div>
        ) : null}
        {node.children.length > 0 ? (
          <div className="mt-2 space-y-1">{renderAll(node.children, ctx)}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- NotePreview

/**
 * A read-only pointer at one of the user's notes.
 *
 * The extension supplies a path and its own excerpt; it never receives the
 * file's contents and cannot observe whether opening it worked. The path still
 * goes through Rust's workspace containment when the user clicks, because an
 * extension that can aim the host at any file on disk can put a user's private
 * keys on screen beside a persuasive sentence.
 */
function NotePreviewRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const path = str(node.props.path);
  const highlight = str(node.props.highlight);
  return (
    <button
      type="button"
      className="flex w-full flex-col gap-0.5 rounded border border-[var(--line-subtle)] px-2 py-1.5 text-left hover:bg-[var(--item-hover-bg)]"
      onClick={() => ctx.effects.openNote(path)}
    >
      <span className="flex items-center gap-1 truncate text-[12px] text-[var(--text-primary)]">
        <ExtensionIcon name="document" size={12} color="muted" />
        {path.split("/").pop() || path}
      </span>
      {highlight ? (
        <span className="line-clamp-3 text-[11px] text-[var(--text-muted)]">{highlight}</span>
      ) : null}
    </button>
  );
}

// ----------------------------------------------------------------- structural

function SectionRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  return (
    <div className="py-1">
      {/* Title and subtitle share a row. Stacked, the subtitle reads as an
          orphaned value rather than a count for the heading beside it. */}
      {node.props.title || node.props.subtitle ? (
        <div className="flex items-baseline justify-between gap-2 px-3 py-1 text-[10px] text-[var(--text-muted)]">
          <span className="truncate tracking-wide uppercase">{str(node.props.title)}</span>
          {node.props.subtitle ? (
            <span className="shrink-0">{str(node.props.subtitle)}</span>
          ) : null}
        </div>
      ) : null}
      {renderAll(node.children, ctx)}
    </div>
  );
}

function EmptyViewRenderer(node: HostNode, ctx: RenderContext): ReactNode {
  const actions = childrenOfType(node, "ActionPanel")[0];
  return (
    <div className="flex flex-col items-center justify-center gap-1 py-10 text-[13px] text-[var(--text-muted)]">
      {node.props.icon ? (
        <ExtensionIcon name={icon(node.props.icon)} size={24} color="muted" />
      ) : null}
      <span className="text-[var(--text-primary)]">{str(node.props.title, "Nothing here")}</span>
      {node.props.description ? (
        <span className="text-[11px]">{str(node.props.description)}</span>
      ) : null}
      {actions ? <RenderNode node={actions} ctx={ctx} /> : null}
    </div>
  );
}

function TextRenderer(node: HostNode): ReactNode {
  return <>{str(node.props.text)}</>;
}

/**
 * Actions and action containers never render in place; whichever ActionPanel
 * holds them draws them. They are still registered so the drift test can see
 * that the host knows about them, and so a stray one does not print "unknown
 * component" at the user.
 */
const renderNothing = (): ReactNode => null;

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
  "Detail.Metadata.Link": MetadataLinkRenderer,
  "Detail.Metadata.Separator": MetadataSeparatorRenderer,
  "Detail.Metadata.TagList": MetadataTagListRenderer,
  "Detail.Metadata.TagList.Item": MetadataTagRenderer,

  Form: FormRenderer,
  "Form.TextField": TextFieldRenderer,
  "Form.PasswordField": PasswordFieldRenderer,
  "Form.TextArea": TextAreaRenderer,
  "Form.Checkbox": CheckboxRenderer,
  "Form.Dropdown": DropdownRenderer,
  "Form.Dropdown.Item": DropdownItemRenderer,
  "Form.Dropdown.Section": SectionRenderer,
  "Form.TagPicker": TagPickerRenderer,
  "Form.TagPicker.Item": TagPickerItemRenderer,
  "Form.Description": DescriptionRenderer,
  "Form.Separator": SeparatorRenderer,

  Grid: GridRenderer,
  "Grid.Item": GridItemRenderer,
  "Grid.Section": GridSectionRenderer,
  "Grid.EmptyView": EmptyViewRenderer,

  ActionPanel: ActionPanelRenderer,
  "ActionPanel.Section": renderNothing,
  "ActionPanel.Submenu": renderNothing,
  Action: renderNothing,
  "Action.OpenNote": renderNothing,
  "Action.CopyToClipboard": renderNothing,
  "Action.OpenInBrowser": renderNothing,
  "Action.SubmitForm": renderNothing,
  "Action.Push": renderNothing,
  "Action.Pop": renderNothing,

  Chat: ChatRenderer,
  "Chat.Message": ChatMessageRenderer,

  NotePreview: NotePreviewRenderer,
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
  effects,
}: {
  root: HostNode[];
  dispatch: EventDispatch;
  effects: HostEffects;
}): ReactNode {
  // Stable across renders and mutated in place on purpose: it is written during
  // render by every field and read only when an action fires, so rebuilding it
  // per render would drop everything typed since the last commit.
  const formValues = useMemo(() => new Map<string, JsonValue>(), []);
  const ctx = useMemo(() => ({ dispatch, effects, formValues }), [dispatch, effects, formValues]);
  return <>{renderAll(root, ctx)}</>;
}
