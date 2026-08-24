// The agent's streamed record shapes (from apps/authoring-agent — Ai.AgentStream
// parts, journaled and delivered over SSE as { id, data: <part> }). Kept loose
// where the wire shape is provider-defined; only the fields the panel reads are typed.
export type AgentStreamPart =
  | { type: "text-delta"; delta: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "tool-result"; toolResult: ToolResult }
  | { type: "finish"; usage?: Usage; finishReason?: string }
  | { type: "error"; error?: unknown; message?: string }
  | { type: string; [k: string]: unknown };

export interface ToolCall {
  toolCallId?: string;
  name: string;
  args?: unknown;
  input?: unknown;
}

export interface ToolResult {
  toolCallId?: string;
  name?: string;
  content?: unknown;
  error?: boolean | string;
  // write_file / edit_file carry the auto-`telo check` verdict.
  checkExitCode?: number;
  checkOutput?: string;
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** One agent-persisted conversation row (the MODEL's history, as opposed to the
 *  editor's richer display transcript). Snapshotted from `GET /conversations/{id}`
 *  after each turn and seeded into a fresh per-session instance via
 *  `POST /conversations/{id}/messages` before its first turn — per-session
 *  containers start with an empty DB even though the conversation continues. */
export interface AgentHistoryRow {
  id: string;
  role: string;
  content: string;
  createdAt: string;
}

// ── Editor-side transcript model ────────────────────────────────────────────

export type ChatRole = "user" | "assistant";
export type ToolState = "running" | "done" | "error";

export interface ToolCallView {
  toolCallId: string;
  name: string;
  args?: unknown;
  state: ToolState;
  output?: unknown;
  checkExitCode?: number;
  checkOutput?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  tools: ToolCallView[];
  error?: string;
  /** True while the assistant turn is still streaming. */
  pending?: boolean;
}

export type AgentStatus = "idle" | "launching" | "seeding" | "streaming" | "error";

/**
 * The editor registers this bridge so the agent context can seed the agent's
 * workspace from the editor's files and reflect the agent's writes back — all
 * through the editor's own WorkspaceAdapter (the durable home).
 */
export interface WorkspaceBridge {
  /** Content-hash the editor's workspace (path → sha256 hex), excluding vendor dirs. */
  snapshot(): Promise<Map<string, string>>;
  readFile(path: string): Promise<string>;
  /** Apply agent → editor changes through WorkspaceAdapter + afterFileMutation. */
  applyChanges(writes: Array<{ path: string; content: string }>, deletes: string[]): Promise<void>;
}
