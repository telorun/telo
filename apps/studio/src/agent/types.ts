// The agent's journal records (from apps/authoring-agent): a turn's
// `user-message` lead record, then every Ai.AgentStreamPart — and, where the
// turn was continued, a `turn-continued` record opening each further attempt —
// each delivered as
// { id, data: <part> } — over SSE from GET /chat/{turnId}/events and in pages
// from GET /conversations/{id}/records. Kept loose where the wire shape is
// provider-defined; only the fields the panel reads are typed.
export type AgentStreamPart =
  | { type: "user-message"; content: string; model?: string }
  | { type: "text-delta"; delta: string }
  // The model's own summary of its thinking, streamed ahead of the answer. Only
  // ever a PRÉCIS: the reasoning itself comes back encrypted and is replayed
  // through `providerState`, never shown, so this arrives only where the model
  // resource asks for `reasoning.summary`.
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call"; toolCall: ToolCall }
  | { type: "tool-result"; toolResult: ToolResult }
  // Closes one model call; the next text starts a segment of its own.
  | { type: "step-finish"; usage?: Usage; finishReason?: string }
  | { type: "finish"; usage?: Usage; finishReason?: string }
  // Opens another attempt at an interrupted turn; `note` is what its model was
  // told about the interruption.
  | { type: "turn-continued"; note: string; model?: string }
  | { type: string; [k: string]: unknown };

/** One journaled record: its id within the turn and the part it carries. */
export interface JournalRecord {
  id: number;
  data: AgentStreamPart;
}

/** How a turn ended with an error — an `event: error` frame, or a failed turn's
 *  `error` in the records route. Rendered by `code`. */
export interface TurnError {
  code?: string;
  message: string;
}

/** One turn as GET /conversations/{id}/records reports it. */
export interface TurnRecords {
  turnId: string;
  status: "running" | "finished" | "failed" | "aborted";
  error: TurnError | null;
  startedAt?: string;
  records: JournalRecord[];
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
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

/**
 * One run of an assistant turn, in the order it streamed. A thinking segment is
 * the model's summary of its own thinking — not the answer: a resume never
 * quotes it, and a client is free not to show it. It is journaled like every
 * other part, so it survives a reload.
 */
export type AssistantPart =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: ToolCallView }
  // Where an interrupted turn was continued: the next attempt's parts follow.
  | { kind: "continued" };

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  /** The turn's parts in stream order — the one shape both the live stream and
   *  the records route fold into. */
  parts: AssistantPart[];
  error?: string;
  /** The code of the error the turn ended with, when it carried one. */
  errorCode?: string;
  /** Set by a model call's `step-finish`: the next text opens a segment of its
   *  own rather than extending the previous call's. */
  callBoundary?: boolean;
  /** True while the assistant turn is still streaming. */
  pending?: boolean;
  /** The id of the last journal record folded into this turn — where a
   *  re-attach resumes the turn's event stream. */
  lastRecordId?: number;
  /** Set when the user's abort ended this turn. A chosen ending is not
   *  interrupted work, so the turn offers no Resume. */
  stopped?: boolean;
  /** Set when the turn's own `finish` record arrived. `pending` is cleared by
   *  every ending, a failure included, so this is the one thing that separates
   *  a reply that completed from one cut short — which is what decides whether
   *  there is anything to resume. Absent on transcripts persisted before it
   *  existed; those read as unfinished, which shows no button on its own. */
  completed?: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage;

/** `stopping`: the abort was accepted and the turn's stream is still open,
 *  waiting for the cancellation to end it. */
export type AgentStatus = "idle" | "launching" | "seeding" | "streaming" | "stopping" | "error";

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
