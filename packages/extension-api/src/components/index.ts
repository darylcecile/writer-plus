/**
 * Host-owned UI primitives.
 *
 * These are the ONLY components an extension can render. Each is a thin
 * factory producing a host element whose `type` is a string the host renderer
 * registry knows how to draw with Writer's own themed components. An
 * extension cannot introduce a new visual primitive, cannot pass className or
 * style, and cannot emit raw markup — which is exactly what keeps every
 * extension on the user's theme and keeps the UI layer non-exploitable.
 *
 * Shape follows Raycast so the authoring model is familiar.
 */

import { createElement, isValidElement, type ReactNode } from "react";
import type {
  ActionProps,
  ChatProps,
  DetailProps,
  DropdownProps,
  EmptyViewProps,
  FormProps,
  GridProps,
  ListProps,
  ListItemProps,
  SectionProps,
  FieldProps,
} from "../types";

type Factory<P> = (props: P & { children?: ReactNode }) => ReactNode;

/**
 * True when a prop value is a subtree rather than data.
 *
 * Elements are hoisted out of props and into the children list, because React
 * never renders a prop and a React element is not serializable. The host then
 * identifies them by child `type` (`ActionPanel`, `List.Dropdown`,
 * `Detail.Metadata`), which is unambiguous - no renderer looks a hoisted
 * subtree up by the prop name it arrived under.
 *
 * This is decided by **value, not by name**, and both halves of that matter:
 *
 * - By value, so the set cannot drift. A React element is a plain object, so
 *   the reconciler's sanitizer walks any element left in props and emits a
 *   gutted husk instead of rejecting it: the subtree never renders and nothing
 *   is logged. A hand-maintained list of prop names is exactly the kind of
 *   thing that silently falls behind `../types`, and did.
 * - Not by name, because names collide across components. `Action.Push` takes
 *   `target` as a subtree while `Detail.Metadata.Link` takes `target` as a URL
 *   string; hoisting every `target` would strip the link's destination and
 *   append it as stray text.
 */
function isElementish(value: unknown): boolean {
  if (isValidElement(value)) return true;
  if (Array.isArray(value)) return value.some(isElementish);
  return false;
}

/** @internal */
export const HOST_COMPONENT = Symbol.for("writer.hostComponent");

/** Every component type an extension can render. @internal */
export function hostComponentType(value: unknown): string | undefined {
  if (typeof value !== "function" && (typeof value !== "object" || value === null))
    return undefined;
  const tag = (value as Record<symbol, unknown>)[HOST_COMPONENT];
  return typeof tag === "string" ? tag : undefined;
}

function host<P>(type: string): Factory<P> {
  const component = (props: P & { children?: ReactNode }) => {
    const rest = { ...(props as Record<string, unknown>) };
    const children = rest.children as ReactNode;
    delete rest.children;

    const hoisted: ReactNode[] = [];
    for (const key of Object.keys(rest)) {
      if (isElementish(rest[key])) {
        hoisted.push(rest[key] as ReactNode);
        delete rest[key];
      }
    }
    return createElement(type, rest, ...hoisted, children);
  };
  Object.defineProperty(component, "name", { value: type });
  // Marks this as a renderable host component, as opposed to the capability
  // functions that sit beside it in the same module. The host's drift test
  // uses it to enumerate exactly what an extension can put on screen; a walker
  // that went by `typeof value === "function"` would report `fs.read` as a
  // component with no renderer and drown the real gaps in noise.
  Object.defineProperty(component, HOST_COMPONENT, { value: type });
  return component;
}

// ------------------------------------------------------------------- List

const ListRoot = host<ListProps>("List");
const ListItem = host<ListItemProps>("List.Item");
const ListSection = host<SectionProps>("List.Section");
const ListEmptyView = host<EmptyViewProps>("List.EmptyView");
const ListDropdown = host<DropdownProps>("List.Dropdown");

export const List = Object.assign(ListRoot, {
  Item: ListItem,
  Section: ListSection,
  EmptyView: ListEmptyView,
  Dropdown: ListDropdown,
});

// ----------------------------------------------------------------- Detail

const DetailRoot = host<DetailProps>("Detail");
const DetailMetadata = host<{ children?: ReactNode }>("Detail.Metadata");
const DetailLabel = host<{ title: string; text?: string; icon?: string }>("Detail.Metadata.Label");
const DetailLink = host<{ title: string; target: string; text: string }>("Detail.Metadata.Link");
const DetailSeparator = host<Record<string, never>>("Detail.Metadata.Separator");
const DetailTagList = host<{ title: string; children?: ReactNode }>("Detail.Metadata.TagList");
const DetailTag = host<{ text: string; color?: string }>("Detail.Metadata.TagList.Item");

export const Detail = Object.assign(DetailRoot, {
  Metadata: Object.assign(DetailMetadata, {
    Label: DetailLabel,
    Link: DetailLink,
    Separator: DetailSeparator,
    TagList: Object.assign(DetailTagList, { Item: DetailTag }),
  }),
});

// ------------------------------------------------------------------- Form

const FormRoot = host<FormProps>("Form");
/**
 * There is deliberately no `Form.FilePicker`.
 *
 * A native picker hands the extension absolute filesystem paths for anything
 * the user selects, including files outside the workspace, and no capability
 * covers that - `workspace.read` is scoped to the vault precisely so an
 * extension cannot reach `~/.ssh`. Shipping one for API symmetry would put a
 * path-disclosure primitive outside the permission model the whole system
 * exists to enforce, and would do it through a dialog that looks like the
 * user's own choice. If extensions ever need this, it needs its own capability
 * and its own consent wording, not a component.
 */

export const Form = Object.assign(FormRoot, {
  TextField: host<FieldProps<string>>("Form.TextField"),
  PasswordField: host<FieldProps<string>>("Form.PasswordField"),
  TextArea: host<FieldProps<string> & { enableMarkdown?: boolean }>("Form.TextArea"),
  Checkbox: host<FieldProps<boolean> & { label: string }>("Form.Checkbox"),
  Dropdown: Object.assign(host<FieldProps<string>>("Form.Dropdown"), {
    Item: host<{ value: string; title: string; icon?: string }>("Form.Dropdown.Item"),
    Section: host<SectionProps>("Form.Dropdown.Section"),
  }),
  TagPicker: Object.assign(host<FieldProps<string[]>>("Form.TagPicker"), {
    Item: host<{ value: string; title: string }>("Form.TagPicker.Item"),
  }),
  Separator: host<Record<string, never>>("Form.Separator"),
  Description: host<{ title?: string; text: string }>("Form.Description"),
});

// ------------------------------------------------------------------- Grid

const GridRoot = host<GridProps>("Grid");
export const Grid = Object.assign(GridRoot, {
  Item: host<{ content: string; title?: string; subtitle?: string; actions?: ReactNode }>(
    "Grid.Item",
  ),
  Section: host<SectionProps>("Grid.Section"),
  EmptyView: host<EmptyViewProps>("Grid.EmptyView"),
});

// ------------------------------------------------------------ ActionPanel

const ActionPanelRoot = host<{ title?: string; children?: ReactNode }>("ActionPanel");
export const ActionPanel = Object.assign(ActionPanelRoot, {
  Section: host<SectionProps>("ActionPanel.Section"),
  Submenu: host<{ title: string; icon?: string; children?: ReactNode }>("ActionPanel.Submenu"),
});

// ----------------------------------------------------------------- Action

const ActionRoot = host<ActionProps>("Action");
export const Action = Object.assign(ActionRoot, {
  /** Built-ins are host-implemented: the host performs the effect itself, so
   *  a common action does not force the extension to hold a capability. */
  OpenNote: host<{ path: string; title?: string }>("Action.OpenNote"),
  CopyToClipboard: host<{ content: string; title?: string }>("Action.CopyToClipboard"),
  OpenInBrowser: host<{ url: string; title?: string }>("Action.OpenInBrowser"),
  SubmitForm: host<{ title?: string; onSubmit: (values: Record<string, unknown>) => void }>(
    "Action.SubmitForm",
  ),
  Push: host<{ title: string; target: ReactNode }>("Action.Push"),
  Pop: host<{ title?: string }>("Action.Pop"),
});

// ------------------------------------------------------- Writer-specific

/** Message list + composer + streaming indicator. Writer-specific because a
 *  chat surface built out of List/Detail would be worse in every way. */
const ChatRoot = host<ChatProps>("Chat");
export const Chat = Object.assign(ChatRoot, {
  Message: host<{
    role: "user" | "assistant" | "system";
    content: string;
    streaming?: boolean;
    citations?: { path: string; title: string; excerpt?: string }[];
  }>("Chat.Message"),
});

/** Read-only preview of a note by path. The host reads the file with the
 *  user's own authority, so previewing does not require workspace.read. */
export const NotePreview = host<{ path: string; highlight?: string }>("NotePreview");
