/**
 * An ACP client that runs inside the extension sandbox.
 *
 * ## Why this lives here and not in the host
 *
 * An AI harness is a separate OS process running as the user. Writer cannot
 * sandbox it, cannot audit it, and cannot revoke it once started. Shipping it
 * as a host capability alongside `workspace.read` would have implied a
 * guarantee that does not exist. So the host offers only generic child-process
 * primitives behind the `unsafe` grant, and *this extension* owns the protocol.
 *
 * The practical payoff: any ACP-speaking harness works — Copilot, Claude Code,
 * Codex, Gemini — and adding one is an extension update, not a Writer release.
 *
 * ## What is still gated
 *
 * `unsafe` buys the right to spawn a process. It does not hand the agent the
 * user's notes. The agent asks *us* for files (`fs/read_text_file`), and this
 * client answers by calling `workspace.read`, which the Rust gate scope-checks
 * against the manifest's glob allowlist exactly as it would for any other
 * extension. An agent that asks for `~/.ssh/id_rsa` gets a denial, not a key.
 *
 * That is protocol convention, not containment: a hostile harness could read
 * the file directly and never ask. The gate is meaningful against an honest
 * agent behaving badly, not against a malicious one. Which is precisely why
 * the user is asked to trust the harness itself, once, up front.
 */

import { process as proc, workspace } from "@writer/extension-api";
import {
  INTERNAL_ERROR,
  METHOD_NOT_FOUND,
  PROTOCOL_VERSION,
  type InitializeResult,
  type JsonRpcMessage,
  type NewSessionResult,
  type PromptResult,
  type SessionNotificationParams,
} from "./protocol";
import type { Harness } from "./harnesses";

/** How long to wait between drains of the child's stdout. */
const POLL_MS = 40;

/** Ceiling on a single request. Model turns are slow; startup is not. */
const HANDSHAKE_TIMEOUT_MS = 30_000;
const PROMPT_TIMEOUT_MS = 300_000;

export interface AgentEvents {
  /** A chunk of the assistant's reply. */
  onText(delta: string): void;
  /** The agent started or updated a tool call, for progress display. */
  onActivity?(label: string): void;
  /** Something went wrong that the user should see but that is not fatal. */
  onWarning?(message: string): void;
}

export class AcpError extends Error {
  constructor(
    message: string,
    readonly kind: "not-installed" | "spawn" | "protocol" | "timeout" | "agent",
  ) {
    super(message);
    this.name = "AcpError";
  }
}

export class AcpClient {
  #handle: string | null = null;
  #nextId = 1;
  #sessionId: string | null = null;
  /** Requests we sent that have not yet been answered. */
  #pending = new Map<number, (msg: JsonRpcMessage) => void>();
  #events: AgentEvents = { onText: () => {} };
  #closed = false;
  /** Set while a prompt turn is in flight, so cancel() knows what to target. */
  #turnActive = false;

  get running(): boolean {
    return this.#handle !== null && !this.#closed;
  }

  /**
   * Start the harness and complete the handshake.
   *
   * Resolving the program first turns the most common failure — the tool is
   * simply not installed — into an actionable message instead of a spawn error
   * that names a binary the user has never heard of.
   */
  async start(harness: Harness, cwd: string, events: AgentEvents): Promise<void> {
    this.#events = events;

    const resolved = await proc.which(harness.program);
    if (!resolved) {
      throw new AcpError(`${harness.name} is not installed. ${harness.install}`, "not-installed");
    }

    try {
      this.#handle = await proc.spawn(resolved, harness.args, { cwd });
    } catch (err) {
      throw new AcpError(`Could not start ${harness.name}: ${text(err)}`, "spawn");
    }

    const init = await this.#request<InitializeResult>(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
        clientInfo: { name: "Writer", version: "0.1.0" },
      },
      HANDSHAKE_TIMEOUT_MS,
    );

    // A harness that speaks a newer protocol is expected to negotiate down. If
    // it insists on a version we do not implement, failing loudly beats a
    // stream of confusing decode errors later.
    if (init.protocolVersion !== PROTOCOL_VERSION) {
      await this.stop();
      throw new AcpError(
        `${harness.name} requires ACP v${init.protocolVersion}; Writer speaks v${PROTOCOL_VERSION}.`,
        "protocol",
      );
    }

    const session = await this.#request<NewSessionResult>(
      "session/new",
      { cwd, mcpServers: [] },
      HANDSHAKE_TIMEOUT_MS,
    );
    this.#sessionId = session.sessionId;
  }

  /**
   * Run one prompt turn. Text arrives through `events.onText` as it streams;
   * the promise resolves once the agent reports a stop reason.
   */
  async prompt(text_: string): Promise<string> {
    if (!this.#sessionId) throw new AcpError("No session; call start() first.", "protocol");

    this.#turnActive = true;
    try {
      const result = await this.#request<PromptResult>(
        "session/prompt",
        { sessionId: this.#sessionId, prompt: [{ type: "text", text: text_ }] },
        PROMPT_TIMEOUT_MS,
      );
      return result.stopReason;
    } finally {
      this.#turnActive = false;
    }
  }

  /**
   * Ask the agent to abandon the current turn. Fire-and-forget by design:
   * `session/cancel` is a notification, and the turn's own promise resolves
   * with `stopReason: "cancelled"`.
   */
  async cancel(): Promise<void> {
    if (!this.#sessionId || !this.#turnActive) return;
    await this.#notify("session/cancel", { sessionId: this.#sessionId });
  }

  async stop(): Promise<void> {
    this.#closed = true;
    const handle = this.#handle;
    this.#handle = null;
    this.#sessionId = null;
    // Reject anything still waiting, or its caller hangs until timeout.
    for (const settle of this.#pending.values()) {
      settle({ jsonrpc: "2.0", id: -1, error: { code: INTERNAL_ERROR, message: "agent stopped" } });
    }
    this.#pending.clear();
    if (handle) {
      try {
        await proc.kill(handle);
      } catch {
        // Already dead, or the handle was reaped when the extension unloaded.
        // Either way there is nothing left to clean up.
      }
    }
  }

  // ------------------------------------------------------------- transport

  async #send(payload: unknown): Promise<void> {
    if (!this.#handle) throw new AcpError("Agent is not running.", "protocol");
    // Newline-delimited JSON: the newline is the frame boundary, so it is not
    // optional and the host does not add one.
    await proc.write(this.#handle, `${JSON.stringify(payload)}\n`);
  }

  async #notify(method: string, params: unknown): Promise<void> {
    await this.#send({ jsonrpc: "2.0", method, params });
  }

  async #request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.#nextId++;
    let settle!: (msg: JsonRpcMessage) => void;
    const answered = new Promise<JsonRpcMessage>((resolve) => {
      settle = resolve;
    });
    this.#pending.set(id, settle);

    await this.#send({ jsonrpc: "2.0", id, method, params });

    const deadline = Date.now() + timeoutMs;
    let done = false;
    void answered.then(() => {
      done = true;
    });

    // The pump is driven from here rather than from a background loop because
    // QuickJS has no threads: if nobody is awaiting, nothing runs. Every
    // in-flight request pumps, and interleaved pumping is harmless since
    // dispatch is keyed by id.
    while (!done) {
      if (Date.now() > deadline) {
        this.#pending.delete(id);
        throw new AcpError(
          `${method} timed out after ${Math.round(timeoutMs / 1000)}s.`,
          "timeout",
        );
      }
      await this.#pump();
      if (done) break;
      await sleep(POLL_MS);
    }

    const msg = await answered;
    if (msg.error) {
      throw new AcpError(msg.error.message || `${method} failed`, "agent");
    }
    return msg.result as T;
  }

  /** Drain whatever the child has emitted and dispatch each message. */
  async #pump(): Promise<void> {
    if (!this.#handle) return;

    const out = await proc.read(this.#handle);

    for (const line of out.stdout) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed) as JsonRpcMessage;
      } catch {
        // Harnesses occasionally print banners or warnings on stdout before
        // the protocol settles. Skipping a non-JSON line is right; treating it
        // as fatal would make the client hostage to cosmetic output.
        continue;
      }
      await this.#dispatch(msg);
    }

    if (out.exitCode !== null && !this.#closed) {
      const why = out.stderr.slice(-5).join("\n").trim();
      this.#closed = true;
      for (const settleFn of this.#pending.values()) {
        settleFn({
          jsonrpc: "2.0",
          id: -1,
          error: {
            code: INTERNAL_ERROR,
            message: `Agent exited (code ${out.exitCode})${why ? `: ${why}` : ""}`,
          },
        });
      }
      this.#pending.clear();
    }
  }

  async #dispatch(msg: JsonRpcMessage): Promise<void> {
    // A response to something we sent.
    if (typeof msg.id === "number" && msg.method === undefined) {
      const settle = this.#pending.get(msg.id);
      if (settle) {
        this.#pending.delete(msg.id);
        settle(msg);
      }
      return;
    }

    // A request *from* the agent. It is blocking on our answer, so every path
    // through here must reply exactly once.
    if (typeof msg.id === "number" && msg.method) {
      await this.#handleAgentRequest(msg.id, msg.method, msg.params);
      return;
    }

    // A notification.
    if (msg.method === "session/update") {
      this.#handleUpdate(msg.params as SessionNotificationParams);
    }
  }

  #handleUpdate(params: SessionNotificationParams): void {
    const update = params?.update;
    if (!update) return;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = update.content;
        if (chunk?.type === "text" && chunk.text) this.#events.onText(chunk.text);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        if (update.title) this.#events.onActivity?.(update.title);
        break;
      }
      default:
        // `usage_update`, `plan`, `available_commands_update`,
        // `agent_thought_chunk`, and whatever the protocol adds next. Ignoring
        // unknown variants is required: `SessionUpdate` is explicitly
        // open-ended, so treating an unrecognised one as an error would break
        // this client every time a harness ships a feature.
        break;
    }
  }

  async #handleAgentRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      switch (method) {
        case "fs/read_text_file": {
          const { path } = params as { path: string };
          // Straight through the permission gate. If the manifest does not
          // cover this path, `workspace.read` throws and the agent gets an
          // error — which is the correct answer.
          const note = await workspace.read(path);
          await this.#respond(id, { content: note.content });
          break;
        }

        case "session/request_permission": {
          // The agent wants to do something consequential. Writer has no UI
          // for an in-turn consent prompt yet, and inventing an implicit
          // "yes" here would quietly undo the point of the permission model,
          // so this refuses and tells the user why.
          const opts = (params as { options?: { optionId: string; kind?: string }[] })?.options;
          const reject = opts?.find((o) => o.kind === "reject_once") ?? opts?.[0];
          this.#events.onWarning?.(
            "The agent asked to take an action that needs approval. Writer declined it — in-chat approval is not implemented yet.",
          );
          await this.#respond(id, {
            outcome: reject
              ? { outcome: "selected", optionId: reject.optionId }
              : { outcome: "cancelled" },
          });
          break;
        }

        default:
          // Terminals, writes, elicitation: all declined, and all declined the
          // same way. We advertised only `fs.readTextFile` in the handshake, so
          // a well-behaved agent will not ask.
          await this.#respondError(id, METHOD_NOT_FOUND, `${method} is not supported by Writer`);
      }
    } catch (err) {
      await this.#respondError(id, INTERNAL_ERROR, text(err));
    }
  }

  async #respond(id: number, result: unknown): Promise<void> {
    await this.#send({ jsonrpc: "2.0", id, result });
  }

  async #respondError(id: number, code: number, message: string): Promise<void> {
    await this.#send({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
