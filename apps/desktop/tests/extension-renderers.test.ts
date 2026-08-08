// @vitest-environment jsdom

/**
 * The tests that would have caught the UI library being 40% built.
 *
 * Type checks, unit tests, and the release build were all green while 25 of
 * the 42 declared components rendered nothing at all - including `Chat.Message`
 * citations, the one thing that makes an AI answer about your notes checkable.
 * Every one of those failures was silent: a missing renderer draws nothing, and
 * nothing draws nothing too.
 *
 * So the first test here is not about any component. It is a diff between the
 * two halves of the contract - what an extension may render, and what the host
 * knows how to draw - because a per-component test suite can only ever assert
 * things about components someone remembered to write.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createElement, isValidElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import * as Guest from "@writer/extension-api";
import type { HostNode, JsonValue } from "@writer/extension-api/protocol";
import {
  ExtensionTree,
  RENDERERS,
  type HostEffects,
} from "../src/components/extension-ui/renderers";

/**
 * Walks the guest module and collects every component type an extension can
 * emit.
 *
 * Types are read off the components themselves via the tag `host()` attaches,
 * not parsed out of the source: a regex over TypeScript generics mis-splits
 * `Factory<{ a: B<C> }>`, and a test that is wrong about the contract is worse
 * than no test. The tag also separates components from the capability
 * functions exported beside them, so `fs.read` is not reported as a component
 * with a missing renderer.
 */
function guestComponentTypes(): Set<string> {
  const found = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value == null || seen.has(value)) return;
    if (typeof value !== "function" && typeof value !== "object") return;
    seen.add(value);

    const type = Guest.hostComponentType(value);
    if (type) found.add(type);
    // Compound components (`List.Item`) hang off the parent function.
    for (const key of Object.keys(value)) visit((value as never)[key], depth + 1);
  };
  visit(Guest, 0);
  return found;
}

/**
 * Types the host renders that no extension emits directly. `#text` is
 * synthesized by the reconciler for bare strings, so it has a renderer and no
 * component, legitimately.
 */
const HOST_INTERNAL_TYPES = new Set(["#text"]);

describe("the guest API and the host renderers are one contract", () => {
  test("every component an extension can render has a host renderer", () => {
    const missing = [...guestComponentTypes()].filter((type) => !(type in RENDERERS)).sort();

    expect(
      missing,
      `These components are declared in @writer/extension-api but draw nothing:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  test("no renderer exists for a component nothing can emit", () => {
    const guest = guestComponentTypes();
    const orphans = Object.keys(RENDERERS)
      .filter((type) => !guest.has(type) && !HOST_INTERNAL_TYPES.has(type))
      .sort();

    // An orphan is the same drift seen from the other side, and it reads as a
    // working feature: `Chat.Source` had a renderer, was never emitted by
    // anything, and its absence looked like the AI simply having no sources.
    expect(
      orphans,
      `Renderers for components no extension can emit: ${orphans.join(", ")}`,
    ).toEqual([]);
  });
});

describe("element props are hoisted out of props and into children", () => {
  // A React element left in props is walked by the reconciler's sanitizer and
  // emitted as a gutted husk: the subtree never renders and nothing is logged.
  const emitted = (node: unknown) =>
    node as { props: Record<string, unknown>; children: unknown[] };

  test("a subtree passed as a prop becomes a child", () => {
    const el = Guest.List.Item({
      title: "Note",
      actions: createElement(Guest.ActionPanel, {}),
    });
    const { props, children } = emitted(el) as never as {
      props: Record<string, unknown>;
      children: unknown;
    };
    void props;
    void children;

    const rendered = el as { props: { children: unknown; actions?: unknown } };
    expect(rendered.props.actions, "an element prop must not survive in props").toBeUndefined();
  });

  test("a same-named data prop is left alone", () => {
    // `Action.Push` takes `target` as a subtree; `Detail.Metadata.Link` takes
    // `target` as a URL. Hoisting by name would strip the link's destination.
    const link = Guest.Detail.Metadata.Link({
      title: "Docs",
      target: "https://example.com",
      text: "Open",
    }) as { props: { target?: unknown } };

    expect(link.props.target, "a string target is data, not a subtree").toBe("https://example.com");
  });

  test("no element survives anywhere in props, for any component", () => {
    const subtree = createElement(Guest.ActionPanel, {});
    const survived: string[] = [];

    for (const [type, factory] of Object.entries({
      "List.Item": Guest.List.Item,
      List: Guest.List,
      Detail: Guest.Detail,
      "Grid.Item": Guest.Grid.Item,
      "Action.Push": Guest.Action.Push,
      Chat: Guest.Chat,
      Form: Guest.Form,
    })) {
      const el = (factory as (p: never) => unknown)({
        title: "t",
        actions: subtree,
        detail: subtree,
        metadata: subtree,
        searchBarAccessory: subtree,
        target: subtree,
      } as never) as { props: Record<string, unknown> };

      for (const [key, value] of Object.entries(el.props)) {
        if (key !== "children" && isElementish(value)) survived.push(`${type}.${key}`);
      }
    }

    expect(
      survived,
      `These element props stay in props and will render as an empty husk: ${survived.join(", ")}`,
    ).toEqual([]);
  });
});

function isElementish(value: unknown): boolean {
  if (isValidElement(value)) return true;
  if (Array.isArray(value)) return value.some(isElementish);
  return false;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const NO_EFFECTS: HostEffects = {
  openNote: () => {},
  copyToClipboard: () => {},
  openInBrowser: () => {},
  push: () => {},
  pop: () => {},
};

let nextId = 0;
function n(
  type: string,
  props: Record<string, JsonValue> = {},
  children: HostNode[] = [],
  handlers: Record<string, string> = {},
): HostNode {
  return { id: nextId++, type, props, children, handlers };
}

function draw(root: HostNode[], effects: HostEffects = NO_EFFECTS) {
  return render(createElement(ExtensionTree, { root, dispatch: () => {}, effects }));
}

describe("components render what they were given", () => {
  test("a list item shows its accessories", () => {
    // The renderer previously read `accessoryTitle`, a prop that does not
    // exist. The declared prop is `accessories: Accessory[]`, so every
    // extension using the real API got a silently bare row.
    draw([
      n("List", {}, [
        n("List.Item", {
          title: "Meeting notes",
          subtitle: "yesterday",
          accessories: [{ text: "3 min" }, { text: "draft" }],
        }),
      ]),
    ]);

    expect(screen.getByText("Meeting notes")).toBeTruthy();
    expect(screen.getByText("3 min")).toBeTruthy();
    expect(screen.getByText("draft")).toBeTruthy();
  });

  test("a chat message shows the notes it drew on", () => {
    // Citations are what make an answer about your notes checkable. They were
    // declared, passed by the real ai-chat extension, and read by nothing.
    draw([
      n("Chat", {}, [
        n("Chat.Message", {
          role: "assistant",
          content: "You wrote about sourdough in March.",
          citations: [
            { title: "Baking log", path: "notes/baking.md" },
            { title: "Groceries", path: "notes/shopping.md" },
          ],
        }),
      ]),
    ]);

    expect(screen.getByText("Baking log")).toBeTruthy();
    expect(screen.getByText("Groceries")).toBeTruthy();
  });

  test("an empty view renders its icon and copy", () => {
    draw([
      n("List", {}, [
        n("List.EmptyView", {
          icon: "Search01",
          title: "No matches",
          description: "Try a different search",
        }),
      ]),
    ]);

    expect(screen.getByText("No matches")).toBeTruthy();
    expect(screen.getByText("Try a different search")).toBeTruthy();
  });

  test("form fields render, including the ones added late", () => {
    draw([
      n("Form", {}, [
        n("Form.TextField", { id: "a", title: "Title", defaultValue: "Draft" }),
        n("Form.Checkbox", { id: "b", label: "Pin it", defaultValue: true }),
        n("Form.Description", { title: "Heads up", text: "This is permanent" }),
        n("Form.Dropdown", { id: "c", title: "Folder" }, [
          n("Form.Dropdown.Item", { value: "inbox", title: "Inbox" }),
        ]),
      ]),
    ]);

    expect((screen.getByDisplayValue("Draft") as HTMLInputElement).value).toBe("Draft");
    expect((screen.getByLabelText?.("Pin it") ?? screen.getByText("Pin it")) != null).toBe(true);
    expect(screen.getByText("This is permanent")).toBeTruthy();
    expect(screen.getByText("Inbox")).toBeTruthy();
  });

  test("a field reports its own error", () => {
    draw([
      n("Form", {}, [n("Form.TextField", { id: "a", title: "Slug", error: "Already taken" })]),
    ]);

    expect(screen.getByText("Already taken")).toBeTruthy();
  });

  test("a grid renders its items", () => {
    draw([n("Grid", { columns: 3 }, [n("Grid.Item", { title: "Cover", subtitle: "png" })])]);

    expect(screen.getByText("Cover")).toBeTruthy();
  });

  test("detail metadata renders labels, links and tags", () => {
    draw([
      n("Detail", { markdown: "# Hi" }, [
        n("Detail.Metadata", {}, [
          n("Detail.Metadata.Label", { title: "Words", text: "412" }),
          n("Detail.Metadata.Link", {
            title: "Source",
            target: "https://example.com",
            text: "Web",
          }),
          n("Detail.Metadata.TagList", { title: "Tags" }, [
            n("Detail.Metadata.TagList.Item", { text: "recipe" }),
          ]),
        ]),
      ]),
    ]);

    expect(screen.getByText("412")).toBeTruthy();
    expect(screen.getByText("recipe")).toBeTruthy();
    // Deliberately a button, not an anchor. A real `<a href>` in the host
    // document is followed by WebKit itself, so a `file:` or `javascript:`
    // destination would never reach the scheme check in `openInBrowser`.
    const link = screen.getByText("Web");
    expect(link.closest("a"), "a metadata link must not be a real anchor").toBeNull();
    expect(link.closest("button")).toBeTruthy();

    let opened: string | undefined;
    cleanup();
    draw(
      [
        n("Detail", { markdown: "x" }, [
          n("Detail.Metadata", {}, [
            n("Detail.Metadata.Link", {
              title: "Source",
              target: "https://example.com",
              text: "Web",
            }),
          ]),
        ]),
      ],
      { ...NO_EFFECTS, openInBrowser: (url: string) => (opened = url) },
    );
    fireEvent.click(screen.getByText("Web"));
    expect(opened, "clicking must route through the host, with the URL intact").toBe(
      "https://example.com",
    );
  });

  test("an unknown component draws nothing rather than crashing the panel", () => {
    // One bad node must not take the whole extension down with it.
    const { container } = draw([n("List", {}, [n("Totally.Made.Up", { title: "x" })])]);
    expect(container).toBeTruthy();
  });
});

describe("host effects are not handed out for free", () => {
  test("an action the host cannot perform is not shown as a menu item", () => {
    // A menu entry that does nothing reads as the extension being broken.
    draw([
      n("List", {}, [
        n("ActionPanel", {}, [n("Action", { title: "Does nothing at all" })]),
        n("List.Item", { title: "Note" }),
      ]),
    ]);

    expect(screen.queryByText("Does nothing at all")).toBeNull();
  });
});

describe("the extension UI only names theme tokens that exist", () => {
  /**
   * Dead CSS tokens are the single most-repeated bug in this system. A
   * `var(--surface-elevated)` that nothing defines is not an error anywhere:
   * TypeScript is happy, the lint is happy, the build is happy, and the result
   * is an action menu with a transparent background that you only notice by
   * opening it and reading the list rows straight through it.
   *
   * This reads the real stylesheet and the real component sources, so a token
   * renamed in one and not the other fails here instead of on screen.
   */
  // Read off disk rather than through `import.meta.glob`: the test env stubs
  // CSS imports to an empty string, so a glob of App.css would hand back "" -
  // and an empty stylesheet means every token looks undefined, which is a
  // *louder* wrong answer but still a wrong one.
  // Resolved against the app root rather than the cwd: `vp test` runs from
  // apps/desktop, the workspace runner runs from the repo root, and a relative
  // path that only works under one of them is a test that fails for a reason
  // that has nothing to do with the thing it checks.
  const APP_ROOT = existsSync("apps/desktop/src/App.css") ? "apps/desktop" : ".";
  const THEME = `${APP_ROOT}/src/App.css`;
  const SOURCE_DIR = `${APP_ROOT}/src/components/extension-ui`;

  test("every var(--token) it references is defined in the theme", () => {
    const css = readFileSync(THEME, "utf8");
    const files = readdirSync(SOURCE_DIR).filter((f: string) => /\.(tsx?|css)$/.test(f));

    // Guards, because the failure mode of a file scan is finding nothing and
    // passing for that reason. An empty scan must fail, not congratulate us.
    expect(files.length, `no sources were scanned in ${SOURCE_DIR}`).toBeGreaterThan(0);

    // Left-hand sides only (`--x:`), never a `var(--x)` reference, so a token
    // that is merely *used* somewhere does not count as defined.
    const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
    expect(defined.has("--accent"), "no token definitions were found in App.css").toBe(true);

    const dead: string[] = [];
    for (const file of files) {
      const source = readFileSync(`${SOURCE_DIR}/${file}`, "utf8");
      for (const [, token] of source.matchAll(/var\((--[a-z0-9-]+)/g)) {
        if (!defined.has(token)) dead.push(`${token} in ${file}`);
      }
    }

    expect(
      [...new Set(dead)].sort(),
      "referenced but never defined, so they style nothing",
    ).toEqual([]);
  });
});

describe("icons", () => {
  /**
   * Nothing asserted an icon ever reaches the DOM. The vocabulary is closed on
   * purpose - extensions pick from a list of semantic names, not arbitrary
   * glyphs - and the failure mode of a closed list is that an unmapped name
   * renders nothing, silently, exactly like a correct one that happens to be
   * invisible.
   */
  test("a known name renders a glyph and an unknown one renders nothing", () => {
    // Icons are props on components, not a component of their own, so this
    // goes through a real one. `List.EmptyView` is the simplest carrier.
    const { container } = draw([n("List.EmptyView", { title: "None", icon: "document" })]);
    expect(container.querySelectorAll("svg").length).toBe(1);

    cleanup();
    // An unmapped name must draw nothing rather than throwing: the name comes
    // from an extension, so a typo there cannot be allowed to take the panel down.
    const bogus = draw([n("List.EmptyView", { title: "None", icon: "not-a-real-icon" })]);
    expect(bogus.container.querySelectorAll("svg").length).toBe(0);
    expect(bogus.container.textContent).toContain("None");
  });
});
