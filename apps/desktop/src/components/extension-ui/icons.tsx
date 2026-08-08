/**
 * The fixed icon set extensions may name.
 *
 * An extension supplies a name from a closed vocabulary, never image data or a
 * URL. That is what keeps artwork on the user's theme and keeps remote-image
 * exfiltration - a `<img src>` pointing at an attacker's host, used to phone
 * home every time a panel renders - off the table entirely.
 *
 * The mapping is the host's business. Extensions ask for "warning"; which glyph
 * that is can change with the app's design without touching a single extension.
 *
 * An unrecognised name renders nothing rather than a placeholder. A name that
 * is merely misspelled should not draw a broken-image box in the middle of an
 * otherwise fine list, and the drift test below pins the vocabulary so a real
 * mismatch is caught at build time instead.
 */

import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Database01Icon,
  Delete02Icon,
  File02Icon,
  Folder01Icon,
  InformationCircleIcon,
  Link01Icon,
  Message01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
  SparklesIcon,
  StarIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { Color, Icon } from "@writer/extension-api";

/**
 * Every member of the guest `Icon` union, mapped to a glyph.
 *
 * Typed as `Record<Icon, ...>` deliberately: adding a name to the guest union
 * without adding it here is then a type error, not a silently blank icon.
 */
const GLYPHS: Record<Icon, typeof File02Icon> = {
  document: File02Icon,
  folder: Folder01Icon,
  search: Search01Icon,
  star: StarIcon,
  clock: Clock01Icon,
  tag: Tag01Icon,
  link: Link01Icon,
  sparkles: SparklesIcon,
  message: Message01Icon,
  database: Database01Icon,
  check: CheckmarkCircle02Icon,
  warning: Alert02Icon,
  error: CancelCircleIcon,
  info: InformationCircleIcon,
  trash: Delete02Icon,
  pencil: PencilEdit02Icon,
  plus: PlusSignIcon,
  refresh: RefreshIcon,
};

/**
 * Colours resolve to theme tokens, never to literal colours.
 *
 * `default` inherits rather than naming a token, so an icon takes the colour of
 * whatever it sits in - the one case where the surrounding component knows
 * better than the extension does.
 */
const COLORS: Record<Color, string> = {
  default: "currentColor",
  muted: "var(--text-muted)",
  accent: "var(--accent)",
  success: "var(--success, var(--accent))",
  warning: "var(--warning, var(--text-secondary))",
  danger: "var(--danger, var(--text-secondary))",
};

export function isIcon(value: unknown): value is Icon {
  return typeof value === "string" && value in GLYPHS;
}

/** Renders a named icon, or nothing when the name is not in the vocabulary. */
export function ExtensionIcon({
  name,
  size = 14,
  color = "default",
}: {
  name: unknown;
  size?: number;
  color?: Color;
}) {
  if (!isIcon(name)) return null;
  return (
    <HugeiconsIcon
      icon={GLYPHS[name]}
      size={size}
      color={COLORS[color] ?? COLORS.default}
      strokeWidth={1.8}
      // Icons here are always decorative: every call site pairs them with a
      // title, so announcing the name would just repeat the label.
      aria-hidden="true"
    />
  );
}

/** The names the host can draw. Exported so a test can pin it to the guest union. */
export const ICON_NAMES = Object.keys(GLYPHS) as Icon[];
export const COLOR_NAMES = Object.keys(COLORS) as Color[];
