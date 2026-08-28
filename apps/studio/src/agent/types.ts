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
  /** On a message the Resume button generated: the request it is resuming. The
   *  message TEXT also reports what the interrupted turn's tools had already
   *  done, so this is what keeps a second resume quoting the original request
   *  rather than the first resume's own report of it. */
  resumedRequest?: string;
  /** Set when the user cancelled this turn. An ending that is not `finish` is
   *  still an ending, and a CHOSEN one is not resumable work — without this a
   *  Stop whose abort request failed leaves an error banner offering to re-send
   *  the very request that was just cancelled. */
  stopped?: boolean;
  /** Set when the turn's own `finish` record arrived. `pending` is cleared by
   *  every ending, a failure included, so this is the one thing that separates
   *  a reply that completed from one cut short — which is what decides whether
   *  there is anything to resume. Absent on transcripts persisted before it
   *  existed; those read as unfinished, which shows no button on its own. */
  completed?: boolean;
}

export type AgentStatus = "idle" | "launching" | "seeding" | "streaming" | "error";

/** One file of a workspace snapshot: its path and the sha256 of its bytes.
 *  Both surfaces that can hold the shared workspace report this shape — the
 *  agent's `GET /workspace` and the session's `GET /v1/sessions/:id/workspace`. */
export interface TreeFile {
  path: string;
  hash: string;
}

/**
 * The directory the agent and the editor converge on, whichever side of the
 * runner it lives on: a standalone agent's own `./workspace`, or — for a
 * co-resident agent — the watch session's shared volume, which the editor
 * reaches through `/v1/sessions/:id/workspace` and the agent writes directly
 * with its filesystem tools. One interface because the convergence logic is the
 * same either way; only the transport differs.
 */
export interface AgentWorkspace {
  /** Content-hash tree of the shared workspace. */
  tree(): Promise<TreeFile[]>;
  readFile(path: string): Promise<string>;
  apply(write: Array<{ path: string; content: string }>, remove: string[]): Promise<void>;
  /** Paths this surface holds that are nobody's to sync — infrastructure the
   *  runner seeds into the volume rather than files the user authored. Excluded
   *  in BOTH directions: filtering only the workspace side would make every
   *  turn re-push a file the editor happens to have, and only the editor side
   *  would delete one it does not. Empty for a standalone agent, whose
   *  workspace holds nothing the editor did not put there. */
  readonly excludedPaths: ReadonlySet<string>;
}

/**
 * The agent that lives inside a live watch session: where it answers, and the
 * session's own workspace surface. Resolved from the session's `running` status
 * — the runner reports where it routed the agent, because only it knows.
 */
export interface CoResidentAgent {
  runId: string;
  baseUrl: string;
  workspace: AgentWorkspace;
}

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
