import { appendDelta, appendToolCall, settleToolCall } from "./assistant-parts";
import type {
  AgentStreamPart,
  AssistantMessage,
  ChatMessage,
  CheckDiagnostic,
  DiffHunk,
  FileChange,
  JournalRecord,
  ToolCall,
  ToolResult,
  TurnError,
  TurnRecords,
} from "./types";

/**
 * The transcript, folded from the agent's journal records.
 *
 * ONE reducer for both feeds: the records route a conversation is opened from
 * and the event stream a running turn is followed on deliver the same
 * `{ id, data }` records, and folding them in two places is how a reload would
 * come to render a turn differently from the live view that preceded it. A
 * turn is two messages keyed by its id — the user's bubble from its
 * `user-message` record, and the assistant's reply from everything after.
 */

/** The user bubble's id for a turn. */
export function userMessageId(turnId: string): string {
  return `${turnId}:user`;
}

/** The turn a user bubble belongs to, or null for a bubble of no turn yet. */
export function turnOfUserMessage(messageId: string): string | null {
  return messageId.endsWith(":user") ? messageId.slice(0, -":user".length) : null;
}

/** The fields the panel reads from a tool result's structured `output` — the
 *  tool's result before the agent rendered it into text for the model. A card
 *  is chosen by which of them are present, never by the tool's name: a write or
 *  an edit carries `{ path, checkExitCode, checkReport: { diagnostics } | null,
 *  changes, hunks }`, a check the first three, a file removal `changes`, a
 *  command `{ exitCode, output, messages }`. Absent fields read as absent. */
export function toolOutputFields(result: ToolResult | undefined): {
  path?: string;
  checkExitCode?: number;
  diagnostics?: CheckDiagnostic[];
  changes?: FileChange[];
  hunks?: DiffHunk[] | null;
  run?: { exitCode: number; output: string; messages: string };
} {
  const output = result?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) return {};
  const fields = output as Record<string, unknown>;
  const { path, checkExitCode, checkReport, changes, hunks, exitCode, messages } = fields;
  const diagnostics =
    checkReport && typeof checkReport === "object" ? (checkReport as { diagnostics?: unknown }).diagnostics : undefined;
  return {
    ...(typeof path === "string" ? { path } : {}),
    checkExitCode: typeof checkExitCode === "number" ? checkExitCode : undefined,
    diagnostics: Array.isArray(diagnostics) ? (diagnostics as CheckDiagnostic[]) : undefined,
    ...(Array.isArray(changes) ? { changes: changes as FileChange[] } : {}),
    ...(Array.isArray(hunks) ? { hunks: hunks as DiffHunk[] } : hunks === null && "hunks" in fields ? { hunks: null } : {}),
    ...(typeof exitCode === "number" && typeof fields.output === "string"
      ? { run: { exitCode, output: fields.output, messages: typeof messages === "string" ? messages : "" } }
      : {}),
  };
}

function withAssistant(
  messages: ChatMessage[],
  turnId: string,
  fn: (m: AssistantMessage) => AssistantMessage,
): ChatMessage[] {
  const at = messages.findIndex((m) => m.id === turnId && m.role === "assistant");
  if (at === -1) {
    // A turn read from part-way through (a page that starts mid-turn, a stream
    // re-attached after a reload) still has a reply to fold into.
    return [...messages, fn({ id: turnId, role: "assistant", parts: [], pending: true })];
  }
  return messages.map((m, i) => (i === at ? fn(m as AssistantMessage) : m));
}

function delta(part: AgentStreamPart): string {
  const value = (part as { delta?: unknown }).delta;
  return typeof value === "string" ? value : "";
}

/** Fold one record of a turn into the transcript. */
export function applyRecord(messages: ChatMessage[], turnId: string, record: JournalRecord): ChatMessage[] {
  // Every record moves the turn's resume point, the ones with nothing to render
  // included.
  return withAssistant(fold(messages, turnId, record), turnId, (m) => ({ ...m, lastRecordId: record.id }));
}

function fold(messages: ChatMessage[], turnId: string, record: JournalRecord): ChatMessage[] {
  const part = record.data;
  switch (part.type) {
    case "user-message": {
      const text = typeof (part as { content?: unknown }).content === "string" ? (part as { content: string }).content : "";
      const userId = userMessageId(turnId);
      if (messages.some((m) => m.id === userId)) {
        return messages.map((m) => (m.id === userId && m.role === "user" ? { ...m, text } : m));
      }
      return [
        ...messages,
        { id: userId, role: "user", text },
        { id: turnId, role: "assistant", parts: [], pending: true },
      ];
    }
    case "text-delta":
    case "reasoning-delta": {
      const kind = part.type === "text-delta" ? "text" : "thinking";
      return withAssistant(messages, turnId, (m) => ({
        ...m,
        parts: appendDelta(m.parts, kind, delta(part), m.callBoundary === true),
        callBoundary: false,
      }));
    }
    case "step-finish":
      return withAssistant(messages, turnId, (m) => ({ ...m, callBoundary: true }));
    // Another attempt at the same turn: the reply goes on under a divider, and
    // the previous attempt's ending no longer stands.
    case "turn-continued":
      return withAssistant(messages, turnId, (m) => ({
        ...m,
        parts: [...m.parts, { kind: "continued" }],
        callBoundary: true,
        pending: true,
        error: undefined,
        errorCode: undefined,
      }));
    case "tool-call": {
      const call = ((part as { toolCall?: ToolCall }).toolCall ?? { name: "tool" }) as ToolCall;
      return withAssistant(messages, turnId, (m) => ({
        ...m,
        parts: appendToolCall(m.parts, {
          toolCallId: call.id ?? `${call.name ?? "tool"}-${record.id}`,
          name: call.name ?? "tool",
          args: call.arguments,
          state: "running",
        }),
      }));
    }
    case "tool-result": {
      const result = (part as { toolResult?: ToolResult }).toolResult;
      if (!result) return messages;
      const { checkExitCode, diagnostics, ...structured } = toolOutputFields(result);
      return withAssistant(messages, turnId, (m) => ({
        ...m,
        parts: settleToolCall(m.parts, result, (tool) => ({
          ...tool,
          state: result.error === true ? "error" : "done",
          output: result.content,
          checkExitCode,
          diagnostics,
          ...("output" in result ? { structured: result.output } : {}),
          ...structured,
        })),
      }));
    }
    case "context-summary": {
      const { throughTurnId, summary } = part as { throughTurnId?: unknown; summary?: unknown };
      // A failed summarization carries no summary; the turn's error reports it.
      if (typeof throughTurnId !== "string" || typeof summary !== "string") return messages;
      return withAssistant(messages, turnId, (m) => ({
        ...m,
        parts: [...m.parts, { kind: "summary", throughTurnId, summary }],
      }));
    }
    case "conversation-title": {
      const error = (part as { error?: TurnError }).error;
      // Neither a title nor an error: nothing was applied, nothing to show.
      if (!error || typeof error !== "object") return messages;
      return withAssistant(messages, turnId, (m) => ({
        ...m,
        parts: [...m.parts, { kind: "title-error", error: { code: error.code, message: String(error.message ?? "") } }],
      }));
    }
    case "finish": {
      const limit = (part as { limit?: unknown }).limit;
      return withAssistant(messages, turnId, (m) => ({
        ...m,
        pending: false,
        completed: true,
        ...(typeof limit === "string" ? { limit } : {}),
      }));
    }
    default:
      // `provider-state` is the model's own replay material, and a completed
      // `content-part` repeats what its deltas already showed: nothing to render.
      return messages;
  }
}

/** A turn that ended with an error: its reply stops, carrying the error by code. */
export function applyTurnError(messages: ChatMessage[], turnId: string, error: TurnError): ChatMessage[] {
  return withAssistant(messages, turnId, (m) => ({
    ...m,
    pending: false,
    error: error.message,
    ...(error.code === undefined ? {} : { errorCode: error.code }),
  }));
}

/** A turn the user's abort ended: stopped, which is an ending and not an error. */
export function applyTurnStopped(messages: ChatMessage[], turnId: string): ChatMessage[] {
  return withAssistant(messages, turnId, (m) => ({ ...m, pending: false, stopped: true }));
}

/** The turn a Resume would continue: the conversation's last reply, when it
 *  ended without finishing and without being stopped. */
export function interruptedTurn(messages: ChatMessage[]): AssistantMessage | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return null;
  return last.pending || last.completed || last.stopped ? null : last;
}

/** What the user reads for a turn's error: the journal's own endings by code,
 *  anything else by its message. */
export function describeTurnError(error: TurnError): string {
  switch (error.code) {
    case "ERR_JOURNAL_WRITER_LOST":
      return "The agent restarted during this turn.";
    case "ERR_JOURNAL_KEY_REMOVED":
      return "This turn was deleted.";
    default:
      return error.message;
  }
}

/** Fold whole turns, as the records route reports them: every record, then the
 *  turn's status — a running turn stays pending, a failed one carries its error,
 *  an aborted one is stopped — and its summary and recorded revert, which are
 *  state on the turn rather than records of it. */
export function transcriptFromTurns(turns: TurnRecords[]): ChatMessage[] {
  let messages: ChatMessage[] = [];
  for (const turn of turns) {
    for (const record of turn.records) messages = applyRecord(messages, turn.turnId, record);
    if (turn.status === "failed" && turn.error) messages = applyTurnError(messages, turn.turnId, turn.error);
    else if (turn.status === "aborted") messages = applyTurnStopped(messages, turn.turnId);
    else if (turn.status === "finished") messages = withAssistant(messages, turn.turnId, (m) => ({ ...m, pending: false }));
    const { summary, revert } = turn;
    if (summary || revert) {
      messages = withAssistant(messages, turn.turnId, (m) => ({
        ...m,
        ...(summary ? { summary } : {}),
        ...(revert ? { revert } : {}),
      }));
    }
  }
  return messages;
}

/** One page of GET /conversations/{id}/records. */
export interface RecordsPage {
  turns: TurnRecords[];
  next: { fromTurn: string; fromId: number } | null;
}

/**
 * Every record of a conversation, page after page, with a turn split across
 * two pages joined back into one. The server holds the whole transcript, so
 * this needs nothing the browser stored.
 */
export async function readConversation(
  fetchPage: (cursor: { fromTurn: string; fromId: number } | null) => Promise<RecordsPage>,
): Promise<TurnRecords[]> {
  const turns: TurnRecords[] = [];
  let cursor: { fromTurn: string; fromId: number } | null = null;
  do {
    const page: RecordsPage = await fetchPage(cursor);
    for (const turn of page.turns) {
      const last = turns[turns.length - 1];
      if (last && last.turnId === turn.turnId) {
        turns[turns.length - 1] = { ...turn, records: [...last.records, ...turn.records] };
      } else {
        turns.push(turn);
      }
    }
    cursor = page.next;
  } while (cursor !== null);
  return turns;
}
