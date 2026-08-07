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

import { createElement, type ReactNode } from "react";
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

function host<P>(type: string): Factory<P> {
  const component = (props: P & { children?: ReactNode }) =>
    createElement(type, props as Record<string, unknown>);
  Object.defineProperty(component, "name", { value: type });
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
  FilePicker: host<FieldProps<string[]> & { allowMultipleSelection?: boolean }>("Form.FilePicker"),
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
