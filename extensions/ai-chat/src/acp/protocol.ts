/**
 * ACP wire types.
 *
 * Hand-written rather than generated, and deliberately partial: this client
 * only needs the handful of messages required to run a prompt turn. Every
 * shape here was confirmed against a live `copilot --acp` handshake and
 * against the `agent-client-protocol-schema` 1.5.0 source, not recalled.
 *
 * Method names are snake_case within a slash-separated namespace
 * (`fs/read_text_file`); struct fields are camelCase. That mix is not a typo,
 * it is what the protocol does.
 *
 * Framing is newline-delimited JSON. There is no Content-Length header, which
 * is precisely what makes a client viable inside QuickJS over a line-buffered
 * pipe.
 */

/** Latest stable protocol version. v2 exists but is an unstable draft. */
export const PROTOCOL_VERSION = 1;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcResponse & Partial<JsonRpcRequest>;

export interface InitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version?: string };
  authMethods?: { id: string; name: string; description?: string }[];
}

export interface NewSessionResult {
  sessionId: string;
}

export interface PromptResult {
  /** `end_turn` | `cancelled` | `max_tokens` | `refusal` | ... */
  stopReason: string;
}

/** Only the `text` variant is consumed; images and audio are ignored. */
export interface ContentBlock {
  type: string;
  text?: string;
}

export interface SessionUpdate {
  sessionUpdate: string;
  content?: ContentBlock;
  /** Present on `tool_call` / `tool_call_update`. */
  title?: string;
  status?: string;
}

export interface SessionNotificationParams {
  sessionId: string;
  update: SessionUpdate;
}

/** JSON-RPC error codes we produce. Mirrors the spec's reserved range. */
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
