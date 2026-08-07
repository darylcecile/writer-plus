/**
 * Semantic Index — the provider half of the two core extensions.
 *
 * The actual vector work (sqlite-vec, embedding inference) happens in Rust:
 * neither can run inside QuickJS. This extension is the policy and UI layer
 * on top of it, plus the `search` service that AI Chat consumes.
 */

import {
  Action,
  ActionPanel,
  Detail,
  List,
  clipboard,
  embeddings,
  services,
  showToast,
  useCallback,
  useEffect,
  useState,
  workspace,
  type SemanticHit,
  type IndexStatus,
} from "@writer/extension-api";

// ------------------------------------------------------------------ service

/**
 * Exposed to other extensions. Registered at module scope so it is available
 * as soon as the bundle is evaluated - a consumer may call it before any of
 * this extension's own commands have ever been mounted.
 */
services.provide("search", {
  /**
   * Semantic search over the note index.
   *
   * `limit` is clamped rather than trusted. A consumer asking for 10_000 hits
   * would push a huge payload through the JSON boundary and, downstream, into
   * an LLM context window.
   */
  async query(text: unknown, limit: unknown = 8): Promise<SemanticHit[]> {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new Error("query text must be a non-empty string");
    }
    const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : 8;
    return embeddings.query(text, Math.min(Math.max(n, 1), 25));
  },

  async status(): Promise<IndexStatus> {
    return embeddings.status();
  },
});

// ------------------------------------------------------------ search command

export function Search() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SemanticHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }

    // Guards against results from a stale keystroke overwriting newer ones.
    // Requests are async and unordered, so without this the list can end up
    // showing the answer to a query the user already moved past.
    let cancelled = false;
    setLoading(true);

    const timer = setTimeout(() => {
      embeddings
        .query(text, 12)
        .then((results) => {
          if (!cancelled) setHits(results);
        })
        .catch((err: unknown) => {
          if (!cancelled)
            showToast({ style: "failure", title: "Search failed", message: message(err) });
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <List
      isLoading={loading}
      searchBarPlaceholder="Describe what you're looking for…"
      onSearchTextChange={setQuery}
    >
      {hits.length === 0 && query.trim().length >= 2 && !loading ? (
        <List.EmptyView
          title="No related notes"
          description="Nothing in the index matches that yet. Try rephrasing, or rebuild the index."
        />
      ) : null}

      {hits.map((hit) => (
        <List.Item
          key={`${hit.path}:${hit.chunkIndex}`}
          title={hit.title || hit.path}
          subtitle={hit.excerpt}
          accessories={[{ text: similarity(hit.distance) }]}
          actions={
            <ActionPanel>
              <Action title="Open Note" onAction={() => void openNote(hit.path)} />
              <Action title="Copy Path" onAction={() => void copyPath(hit.path)} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

// ------------------------------------------------------------ manage command

export function Manage() {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    embeddings
      .status()
      .then(setStatus)
      .catch((err: unknown) =>
        showToast({
          style: "failure",
          title: "Could not read index status",
          message: message(err),
        }),
      );
  }, []);

  useEffect(refresh, [refresh]);

  const rebuild = useCallback((force: boolean) => {
    setBusy(true);
    showToast({
      style: "animated",
      title: force ? "Rebuilding index…" : "Indexing changed notes…",
    });
    embeddings
      .reindex({ force })
      .then((next) => {
        setStatus(next);
        showToast({
          style: "success",
          title: `Indexed ${next.indexed} of ${next.total} notes`,
        });
      })
      .catch((err: unknown) =>
        showToast({ style: "failure", title: "Indexing failed", message: message(err) }),
      )
      .finally(() => setBusy(false));
  }, []);

  return (
    <Detail
      isLoading={busy || status === null}
      markdown={describeStatus(status)}
      actions={
        <ActionPanel>
          <Action title="Index Changed Notes" onAction={() => rebuild(false)} />
          <Action title="Rebuild Everything" onAction={() => rebuild(true)} />
          <Action title="Refresh Status" onAction={refresh} />
        </ActionPanel>
      }
    />
  );
}

// -------------------------------------------------------------------- helpers

function describeStatus(status: IndexStatus | null): string {
  if (!status) return "Reading index status…";

  const lines = [
    "# Note index",
    "",
    `**${status.indexed}** of **${status.total}** notes indexed.`,
    "",
    `- Model: ${status.model ?? "not loaded"}`,
    `- Dimensions: ${status.dimensions}`,
    `- Last built: ${status.lastBuilt ? new Date(status.lastBuilt).toLocaleString() : "never"}`,
  ];

  if (status.building) {
    lines.push("", "_An indexing pass is currently running._");
  }
  if (status.total > 0 && status.indexed < status.total) {
    lines.push(
      "",
      `${status.total - status.indexed} notes are not indexed yet, so search will miss them.`,
    );
  }

  return lines.join("\n");
}

/**
 * Cosine distance reads backwards to most people (0 is a perfect match), so
 * show a similarity percentage instead of the raw number.
 */
function similarity(distance: number): string {
  const pct = Math.round(Math.max(0, Math.min(1, 1 - distance)) * 100);
  return `${pct}%`;
}

async function openNote(path: string): Promise<void> {
  try {
    await workspace.read(path);
    await showToast({ style: "success", title: "Opened", message: path });
  } catch (err) {
    await showToast({ style: "failure", title: "Could not open note", message: message(err) });
  }
}

async function copyPath(path: string): Promise<void> {
  await clipboard.copy(path);
  await showToast({ style: "success", title: "Path copied" });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default {
  commands: {
    search: Search,
    manage: Manage,
  },
};
