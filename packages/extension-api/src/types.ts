import type { ReactNode } from "react";

/** Icons are a fixed host-provided set. Extensions name one; they cannot
 *  supply arbitrary image data, which keeps remote-image exfiltration and
 *  off-theme artwork off the table. */
export type Icon =
  | "document"
  | "folder"
  | "search"
  | "star"
  | "clock"
  | "tag"
  | "link"
  | "sparkles"
  | "message"
  | "database"
  | "check"
  | "warning"
  | "error"
  | "info"
  | "trash"
  | "pencil"
  | "plus"
  | "refresh";

export type Color = "default" | "muted" | "accent" | "success" | "warning" | "danger";

export interface Accessory {
  text?: string;
  icon?: Icon;
  tag?: string;
  tooltip?: string;
}

export interface ListProps {
  isLoading?: boolean;
  searchBarPlaceholder?: string;
  searchText?: string;
  onSearchTextChange?: (text: string) => void;
  /** When true the host does not filter; the extension owns filtering. */
  filtering?: boolean;
  throttle?: boolean;
  selectedItemId?: string;
  onSelectionChange?: (id: string | null) => void;
  searchBarAccessory?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export interface ListItemProps {
  id?: string;
  title: string;
  subtitle?: string;
  icon?: Icon;
  accessories?: Accessory[];
  keywords?: string[];
  detail?: ReactNode;
  actions?: ReactNode;
}

export interface SectionProps {
  title?: string;
  subtitle?: string;
  children?: ReactNode;
}

export interface EmptyViewProps {
  title: string;
  description?: string;
  icon?: Icon;
  actions?: ReactNode;
}

export interface DropdownProps {
  tooltip?: string;
  value?: string;
  defaultValue?: string;
  placeholder?: string;
  onChange?: (value: string) => void;
  children?: ReactNode;
}

export interface DetailProps {
  /** Markdown. Rendered by the host's own renderer and sanitized there. */
  markdown?: string;
  isLoading?: boolean;
  navigationTitle?: string;
  metadata?: ReactNode;
  actions?: ReactNode;
}

export interface FormProps {
  isLoading?: boolean;
  navigationTitle?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

export interface FieldProps<T> {
  id: string;
  title?: string;
  placeholder?: string;
  info?: string;
  error?: string;
  value?: T;
  defaultValue?: T;
  onChange?: (value: T) => void;
  onBlur?: () => void;
  autoFocus?: boolean;
  children?: ReactNode;
}

export interface GridProps {
  isLoading?: boolean;
  columns?: number;
  aspectRatio?: "1" | "3/2" | "2/3" | "4/3" | "3/4" | "16/9" | "9/16";
  searchBarPlaceholder?: string;
  onSearchTextChange?: (text: string) => void;
  actions?: ReactNode;
  children?: ReactNode;
}

export interface ActionProps {
  title: string;
  icon?: Icon;
  shortcut?: { modifiers: ("cmd" | "ctrl" | "shift" | "opt")[]; key: string };
  onAction?: () => void;
  style?: "regular" | "destructive";
}

export interface ChatProps {
  isLoading?: boolean;
  placeholder?: string;
  onSubmit?: (text: string) => void;
  onStop?: () => void;
  /** Disables the composer without hiding it. */
  disabled?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  actions?: ReactNode;
  children?: ReactNode;
}

// ------------------------------------------------------------- capabilities

export interface NoteRef {
  path: string;
  title: string;
  modified: number;
}

export interface NoteContent extends NoteRef {
  content: string;
}

export interface SearchHit extends NoteRef {
  score: number;
  excerpt?: string;
}

export interface SemanticHit {
  path: string;
  title: string;
  excerpt: string;
  distance: number;
  chunkIndex: number;
}

export interface IndexStatus {
  indexed: number;
  total: number;
  building: boolean;
  model: string | null;
  dimensions: number;
  lastBuilt: number | null;
}

export interface AiMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
}
