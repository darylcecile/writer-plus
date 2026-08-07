/**
 * AI Chat — the consumer half of the two core extensions.
 *
 * Answers are grounded in the user's own notes rather than the model's
 * parametric memory. It retrieves candidate notes through the semantic-index
 * extension's `search` service, then hands them to the model both as context
 * and as a callable tool so the model can go looking for more if the first
 * retrieval missed.
 *
 * Every answer carries its sources. An ungrounded answer about your own notes
 * is worse than no answer, because there is no way to tell it is wrong.
 */

import {
  Action,
  ActionPanel,
  Chat,
  ai,
  services,
  showToast,
  storage,
  useCallback,
  useEffect,
  useRef,
  useState,
  type AiMessage,
  type AiTool,
  type SemanticHit,
} from "@writer/extension-api";

const PROVIDER = "writer.semantic-index";
const HISTORY_KEY = "conversation";
const MAX_PERSISTED = 50;

interface Source {
  path: string;
  title: string;
}

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

const SYSTEM_PROMPT = [
  "You answer questions about the user's personal notes.",
  "",
  "Ground every claim in the notes provided as context, or in notes you retrieve",
  "with the search_notes tool. If the notes do not contain the answer, say so",
  "plainly instead of filling the gap from general knowledge - the user is asking",
  "specifically about what they wrote, so a plausible-sounding invention is worse",
  "than an admission that it is not there.",
  "",
  "Refer to notes by their title. Be concise.",
].join("\n");

const SEARCH_TOOL: AiTool = {
  name: "search_notes",
  description:
    "Search the user's notes by meaning. Use this when the provided context is insufficient, or to check a related topic before answering.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to look for, phrased as a topic or question.",
      },
      limit: {
        type: "number",
        description: "How many notes to return. Defaults to 6.",
      },
    },
    required: ["query"],
  },
};

export function ChatCommand() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  // Held in a ref as well as state because the send handler needs the current
  // history at call time, and closing over the state value would capture a
  // stale snapshot from the render that created the handler.
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

  useEffect(() => {
    storage
      .get<Turn[]>(HISTORY_KEY)
      .then((saved) => {
        if (Array.isArray(saved)) setTurns(saved);
      })
      .catch(() => {
        // A corrupt history should not block the panel; starting empty is a
        // reasonable and visible recovery.
      });
  }, []);

  const persist = useCallback((next: Turn[]) => {
    // Bounded so a long-running conversation cannot grow storage without limit.
    void storage.set(HISTORY_KEY, next.slice(-MAX_PERSISTED) as never);
  }, []);

  const send = useCallback(
    (text: string) => {
      const question = text.trim();
      if (!question || busy) return;

      const userTurn: Turn = { id: `u${Date.now()}`, role: "user", content: question };
      const withUser = [...turnsRef.current, userTurn];
      setTurns(withUser);
      setBusy(true);

      void answer(question, withUser)
        .then(({ content, sources }) => {
          const next = [
            ...withUser,
            { id: `a${Date.now()}`, role: "assistant" as const, content, sources },
          ];
          setTurns(next);
          persist(next);
        })
        .catch((err: unknown) => {
          const next = [
            ...withUser,
            {
              id: `e${Date.now()}`,
              role: "assistant" as const,
              content: `I could not answer that: ${message(err)}`,
            },
          ];
          setTurns(next);
        })
        .finally(() => setBusy(false));
    },
    [busy, persist],
  );

  const clear = useCallback(() => {
    setTurns([]);
    void storage.remove(HISTORY_KEY);
    showToast({ style: "success", title: "Conversation cleared" });
  }, []);

  return (
    <Chat
      isLoading={busy}
      placeholder="Ask about your notes…"
      onSubmit={send}
      actions={
        <ActionPanel>
          <Action title="Clear Conversation" onAction={clear} />
        </ActionPanel>
      }
    >
      {turns.map((turn) => (
        <Chat.Message
          key={turn.id}
          role={turn.role}
          content={turn.content}
          citations={turn.sources ?? []}
        />
      ))}
    </Chat>
  );
}

// ------------------------------------------------------------------ answering

async function answer(
  question: string,
  history: Turn[],
): Promise<{ content: string; sources: Source[] }> {
  const retrieved = await search(question, 6);

  const messages: AiMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-8, -1).map((t) => ({ role: t.role, content: t.content })),
    {
      role: "user",
      content: retrieved.length
        ? `${question}\n\n---\nNotes that may be relevant:\n\n${format(retrieved)}`
        : `${question}\n\n(No notes matched this question in the index.)`,
    },
  ];

  const content = await ai.ask(messages, { tools: [SEARCH_TOOL] });
  return { content, sources: dedupe(retrieved) };
}

/**
 * Retrieval goes through the semantic-index extension rather than calling the
 * embeddings capability directly. That keeps indexing policy in one place and
 * means this extension only needs `usesServices: ["search"]`, not its own
 * grant over the index.
 */
async function search(query: string, limit: number): Promise<SemanticHit[]> {
  try {
    return await services.call<SemanticHit[]>(PROVIDER, "search", "query", [query, limit]);
  } catch (err) {
    // A missing or disabled provider is an expected state, not a crash: the
    // user may simply not have enabled Semantic Index. Degrade to an
    // ungrounded answer and say so, rather than failing the whole turn.
    await showToast({
      style: "failure",
      title: "Semantic Index unavailable",
      message: `Answering without note context. ${message(err)}`,
    });
    return [];
  }
}

function format(hits: SemanticHit[]): string {
  return hits
    .map((hit, i) => `### ${i + 1}. ${hit.title || hit.path}\n(${hit.path})\n\n${hit.excerpt}`)
    .join("\n\n");
}

/** One entry per note, even when several chunks of it matched. */
function dedupe(hits: SemanticHit[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const hit of hits) {
    if (seen.has(hit.path)) continue;
    seen.add(hit.path);
    out.push({ path: hit.path, title: hit.title || hit.path });
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default {
  commands: {
    chat: ChatCommand,
  },
};
