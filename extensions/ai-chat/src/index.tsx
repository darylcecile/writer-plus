/**
 * AI Chat — the consumer half of the two core extensions.
 *
 * Answers are grounded in the user's own notes rather than the model's
 * parametric memory. It retrieves candidate notes through the semantic-index
 * extension's `search` service and hands them to the agent as context.
 *
 * Every answer carries its sources. An ungrounded answer about your own notes
 * is worse than no answer, because there is no way to tell it is wrong.
 *
 * The agent itself is whatever ACP-speaking harness the user already has
 * installed — Copilot, Claude Code, Codex, Gemini. Writer ships no model, no
 * API key, and no vendor relationship. See `acp/client.ts` for why the
 * protocol lives in the extension rather than in the host.
 */

import {
  Action,
  ActionPanel,
  Chat,
  preferences,
  services,
  showToast,
  storage,
  useCallback,
  useEffect,
  useRef,
  useState,
  workspace,
  type SemanticHit,
} from "@writer/extension-api";
import { AcpClient, AcpError } from "./acp/client";
import { findHarness, HARNESSES } from "./acp/harnesses";

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

const SYSTEM_PREAMBLE = [
  "You answer questions about the user's personal notes.",
  "",
  "Ground every claim in the notes provided as context. If the notes do not",
  "contain the answer, say so plainly instead of filling the gap from general",
  "knowledge - the user is asking specifically about what they wrote, so a",
  "plausible-sounding invention is worse than an admission that it is not there.",
  "",
  "Refer to notes by their title. Be concise.",
].join("\n");

export function ChatCommand() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  // Held in refs as well as state because the send handler needs the values at
  // call time; closing over state would capture a stale render snapshot.
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const clientRef = useRef<AcpClient | null>(null);

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

    // The agent is a real OS process. Leaving one running after the panel
    // closes would leak a process per open, so teardown is not optional.
    return () => {
      void clientRef.current?.stop();
      clientRef.current = null;
    };
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
      setStreaming("");
      setStatus("Retrieving notes…");

      let accumulated = "";

      void answer(question, withUser, clientRef, {
        onText: (delta) => {
          accumulated += delta;
          setStreaming(accumulated);
          setStatus(null);
        },
        onActivity: (label) => setStatus(label),
        onWarning: (msg) =>
          showToast({ style: "failure", title: "Agent request declined", message: msg }),
      })
        .then(({ sources }) => {
          const next = [
            ...withUser,
            {
              id: `a${Date.now()}`,
              role: "assistant" as const,
              content: accumulated || "(The agent returned nothing.)",
              sources,
            },
          ];
          setTurns(next);
          persist(next);
        })
        .catch((err: unknown) => {
          setTurns([
            ...withUser,
            {
              id: `e${Date.now()}`,
              role: "assistant" as const,
              // Partial output is kept: a turn that failed halfway through is
              // still more useful than an error with the text thrown away.
              content: accumulated
                ? `${accumulated}\n\n---\n\nThe answer was cut short: ${message(err)}`
                : `I could not answer that: ${message(err)}`,
            },
          ]);
        })
        .finally(() => {
          setBusy(false);
          setStreaming("");
          setStatus(null);
        });
    },
    [busy, persist],
  );

  const clear = useCallback(() => {
    setTurns([]);
    void storage.remove(HISTORY_KEY);
    showToast({ style: "success", title: "Conversation cleared" });
  }, []);

  const stop = useCallback(() => {
    void clientRef.current?.cancel();
  }, []);

  return (
    <Chat
      isLoading={busy}
      placeholder="Ask about your notes…"
      onSubmit={send}
      actions={
        <ActionPanel>
          {busy ? <Action title="Stop" onAction={stop} /> : null}
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
      {streaming ? <Chat.Message key="streaming" role="assistant" content={streaming} /> : null}
      {status ? <Chat.Message key="status" role="assistant" content={`_${status}_`} /> : null}
    </Chat>
  );
}

// ------------------------------------------------------------------ answering

async function answer(
  question: string,
  history: Turn[],
  clientRef: { current: AcpClient | null },
  events: {
    onText: (delta: string) => void;
    onActivity: (label: string) => void;
    onWarning: (message: string) => void;
  },
): Promise<{ sources: Source[] }> {
  const limit = Number((await preferences.get<string>("contextNotes")) ?? "6") || 6;
  const retrieved = await search(question, limit);

  const client = await ensureClient(clientRef, events);

  // The agent is stateful across turns, so only the new question is sent. The
  // preamble goes with the first turn only; repeating it every time wastes
  // tokens and, worse, lets a later copy contradict an earlier one.
  const isFirst = history.filter((t) => t.role === "user").length <= 1;
  const prompt = [
    isFirst ? `${SYSTEM_PREAMBLE}\n\n---\n` : "",
    question,
    retrieved.length
      ? `\n\n---\nNotes that may be relevant:\n\n${format(retrieved)}`
      : "\n\n(No notes matched this question in the index.)",
  ].join("");

  const stopReason = await client.prompt(prompt);
  if (stopReason !== "end_turn" && stopReason !== "cancelled") {
    // `max_tokens`, `refusal`, and anything the protocol adds later. Silence
    // here would look like a complete answer that simply stopped early.
    events.onWarning(`The agent stopped early (${stopReason}).`);
  }

  return { sources: dedupe(retrieved) };
}

/**
 * Lazily start the harness and keep it for the life of the panel.
 *
 * Startup is slow — `npx` presets fetch a package on first run — so paying it
 * once per conversation rather than once per question matters. Keeping the
 * session also means the agent retains conversational context, which is the
 * whole reason ACP has sessions.
 */
async function ensureClient(
  ref: { current: AcpClient | null },
  events: {
    onText: (delta: string) => void;
    onActivity: (label: string) => void;
    onWarning: (message: string) => void;
  },
): Promise<AcpClient> {
  if (ref.current?.running) return ref.current;

  const id = (await preferences.get<string>("harness")) ?? "copilot";
  const harness = findHarness(id);
  if (!harness) {
    throw new AcpError(
      `Unknown assistant '${id}'. Choose one of: ${HARNESSES.map((h) => h.name).join(", ")}.`,
      "not-installed",
    );
  }

  const client = new AcpClient();
  // The agent's cwd is the note workspace, so relative paths it produces mean
  // what the user expects and its file access starts scoped to the notes.
  const root = await workspace.root();
  if (!root) {
    throw new AcpError("Open a workspace before starting a chat.", "spawn");
  }
  await client.start(harness, root, events);
  ref.current = client;
  return client;
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
    showToast({
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
