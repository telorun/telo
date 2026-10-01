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
  // `limit: "max-steps"`: the turn spent its step budget and ended in a wrap-up.
  | { type: "finish"; usage?: Usage; finishReason?: string; limit?: string }
  // Opens another attempt at an interrupted turn; `note` is what its model was
  // told about the interruption.
  | { type: "turn-continued"; note: string; model?: string }
  // The agent's summary of every turn through `throughTurnId`, standing in for
  // them in the model's history from this attempt on — or, with `error` and no
  // `summary`, a summarization that failed, which the turn's own error reports.
  | {
      type: "context-summary";
      throughTurnId: string;
      summary?: string;
      error?: TurnError;
      model?: string;
      usage?: Usage;
    }
  // The conversation's generated title, or why it could not be generated;
  // with neither, a title that was not applied, which changes nothing.
  | { type: "conversation-title"; title?: string; error?: TurnError; model?: string; usage?: Usage }
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
  /** Null while the turn runs; absent from an agent that keeps no summaries. */
  summary?: TurnSummary | null;
  /** Null until a revert of the turn recorded an outcome. */
  revert?: TurnRevert | null;
  records: JournalRecord[];
}

/** One file a turn's tools changed. `added` / `removed` are null for a file
 *  that is not text, or is larger than the agent compares. */
export interface FileChange {
  path: string;
  status: "created" | "modified" | "deleted";
  before: string | null;
  after: string | null;
  added: number | null;
  removed: number | null;
}

export interface DiffLine {
  op: "context" | "added" | "removed";
  text: string;
  noNewline?: boolean;
}

/** One hunk of a line diff, as the agent computed it. Line numbers are 1-based. */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** What an ended turn did. `files: null` is a turn from before the agent kept
 *  checkpoints: what it changed is unknown, not nothing. */
export interface TurnSummary {
  files: Array<FileChange & { firstLine: number | null; checkExitCode: number | null }> | null;
  check: "clean" | "failing" | null;
  runs: Array<{ path: string; exitCode: number }>;
  usage: Usage;
}

/** The recorded outcome of reverting a turn. Present means a revert was
 *  evaluated, not that every path was restored. */
export interface TurnRevert {
  revertedAt: string;
  files: Array<{ path: string; status: FileChange["status"]; outcome: "restored" | "skipped" }>;
}

/** `GET /chat/{turnId}/changes`: the turn's net changes as diffs.
 *  `changedSince`: whether the workspace file no longer holds what the turn
 *  left — null when the agent did not compare it. */
export interface TurnChanges {
  files: Array<FileChange & { firstLine: number | null; hunks: DiffHunk[] | null; changedSince: boolean | null }> | null;
  revert: TurnRevert | null;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
}

export interface ToolResult {
  toolCallId?: string;
  name?: string;
  /** What the model was given — text the agent rendered from the tool's result. */
  content?: unknown;
  error?: boolean | string;
  /** The tool's structured result before its rendering, absent on an error.
   *  write_file / edit_file / telo_check carry `{ path, checkExitCode,
   *  checkReport, … }` here. */
  output?: unknown;
}

/** One diagnostic of a `telo check -o json` report. */
export interface CheckDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: string;
  code?: string;
  message: string;
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
  /** What the model saw: the tool result's `content`. */
  output?: unknown;
  /** The auto-`telo check` verdict of a write, an edit or a check, from the
   *  result's structured `output`. */
  checkExitCode?: number;
  diagnostics?: CheckDiagnostic[];
  /** The tool's structured result, verbatim; absent while it runs, on an error
   *  and from an agent that reports none. */
  structured?: unknown;
  /** The file a write, an edit or a check named. */
  path?: string;
  /** What a file tool's call changed: none or one entry for a write or an
   *  edit, one per file for a delete. */
  changes?: FileChange[];
  /** A write's or an edit's own line diff; null when a side is not comparable. */
  hunks?: DiffHunk[] | null;
  /** A command's exit code, stdout and stderr. */
  run?: { exitCode: number; output: string; messages: string };
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
  | { kind: "continued" }
  // The agent summarized every turn through `throughTurnId` for its model; the
  // panel shows it after that turn, not in the turn that journaled it.
  | { kind: "summary"; throughTurnId: string; summary: string }
  // Naming the conversation failed in this turn.
  | { kind: "title-error"; error: TurnError };

export interface UserMessage {
  id: string;
  role: "user";
  text: string;
  /** Shown before the agent admitted its turn: no turn of the agent's yet. */
  local?: boolean;
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
  /** The `finish` record's `limit`: `max-steps` when the turn spent its step
   *  budget and ended in a wrap-up. */
  limit?: string;
  /** What the turn did, from the records route once the turn has ended. */
  summary?: TurnSummary;
  /** The recorded outcome of reverting the turn, from the records route or
   *  from this client's own revert. */
  revert?: TurnRevert;
  /** Shown before the agent admitted its turn: no turn of the agent's yet. */
  local?: boolean;
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
  /** The per-session token the runner minted for the agent, when it did. */
  token?: string;
  workspace: AgentWorkspace;
}

/** What `GET /capabilities` says about the agent answering. */
export interface AgentIdentity {
  name: string;
  version: string;
  promptId: string;
  /** `"none"` or `"bearer"` today; kept as the agent's own word, so a mode this
   *  client does not know is not mistaken for one it does. */
  auth: string;
  /** The optional surfaces this agent serves (`agent-features.ts` names the
   *  ones this client knows); absent from an agent that predates them. Entries
   *  this client does not know are ignored. */
  features?: string[];
  /** Whether the agent may run manifests and their tests; absent = unknown. */
  manifestRuns?: boolean;
}

/** A conversation as the agent reports it. `revision` moves with every change
 *  to it — a turn admitted or ended, a title, a rename, an archive, a
 *  truncation — so a client that holds an older one holds a stale transcript. */
export interface Conversation {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  model: string | null;
  messageCount: number;
  totalTokens: number;
  archived: boolean;
  revision: number;
}

/** One page of `GET /conversations`, newest activity first. */
export interface ConversationPage {
  conversations: Conversation[];
  next: { before: string; beforeId: string } | null;
}

/** The agent's identity as far as the panel knows it: `unavailable` for an
 *  agent without the route (404), `unauthorized` when it requires a token the
 *  panel does not have, `failed` when the agent could not be asked. */
export type AgentIdentityState =
  | { state: "known"; identity: AgentIdentity }
  | { state: "unavailable" }
  | { state: "unauthorized" }
  | { state: "failed"; message: string };

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
  /** The editor's own path for the file a workspace-relative path names, or
   *  null when it names none: an absolute path, a URL, one that leaves the
   *  workspace. The one place an agent's path becomes an editor's. */
  editorFile(path: string): string | null;
}
