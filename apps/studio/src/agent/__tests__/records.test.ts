import { afterEach, describe, expect, it } from "vitest";

import {
  applyRecord,
  applyTurnError,
  applyTurnStopped,
  readConversation,
  transcriptFromTurns,
  type RecordsPage,
} from "../records";
import type { AssistantMessage, ChatMessage, JournalRecord, TurnRecords } from "../types";

const toolTurn: JournalRecord[] = [
  { id: 1, data: { type: "user-message", content: "build it", model: "m" } },
  { id: 2, data: { type: "reasoning-delta", delta: "plan" } },
  { id: 3, data: { type: "tool-call", toolCall: { id: "call_1", name: "write_file", arguments: { path: "a.yaml" } } } },
  { id: 4, data: { type: "provider-state", providerState: { opaque: true } } },
  { id: 5, data: { type: "step-finish", finishReason: "tool-calls" } },
  {
    id: 6,
    data: {
      type: "tool-result",
      toolResult: {
        toolCallId: "call_1",
        name: "write_file",
        content: "wrote a.yaml\ncheck: clean",
        output: {
          path: "a.yaml",
          bytesWritten: 12,
          checkExitCode: 0,
          checkReport: { ok: true, errorCount: 0, warnCount: 0, diagnostics: [] },
          checkMessages: "",
        },
      },
    },
  },
  { id: 7, data: { type: "text-delta", delta: "Wrote " } },
  { id: 8, data: { type: "text-delta", delta: "it." } },
  { id: 9, data: { type: "step-finish", finishReason: "stop" } },
  { id: 10, data: { type: "finish", finishReason: "stop" } },
];

const failedTurn: JournalRecord[] = [
  { id: 1, data: { type: "user-message", content: "again", model: "m" } },
  { id: 2, data: { type: "text-delta", delta: "Start" } },
  { id: 3, data: { type: "step-finish", finishReason: "stop" } },
  { id: 4, data: { type: "text-delta", delta: "Next call" } },
];

const turns: TurnRecords[] = [
  { turnId: "t1", status: "finished", error: null, records: toolTurn },
  {
    turnId: "t2",
    status: "failed",
    error: { code: "ERR_OPENAI_REQUEST_FAILED", message: "refused" },
    records: failedTurn,
  },
];

afterEach(() => {
  localStorage.clear();
});

describe("records → transcript", () => {
  it("folds the records route exactly as the event streams of the same turns", () => {
    // Live: each turn's records as its event stream delivered them, then the
    // failed turn's `event: error` frame.
    let live: ChatMessage[] = [];
    for (const record of toolTurn) live = applyRecord(live, "t1", record);
    for (const record of failedTurn) live = applyRecord(live, "t2", record);
    live = applyTurnError(live, "t2", { code: "ERR_OPENAI_REQUEST_FAILED", message: "refused" });

    expect(transcriptFromTurns(turns)).toEqual(live);
  });

  it("folds a continued turn and an aborted one exactly as their event streams", () => {
    const continued: JournalRecord[] = [
      ...failedTurn,
      { id: 5, data: { type: "turn-continued", note: "TURN CONTINUED: …", model: "m" } },
      { id: 6, data: { type: "text-delta", delta: "Resumed." } },
      { id: 7, data: { type: "finish", finishReason: "stop" } },
    ];
    const aborted: JournalRecord[] = [
      { id: 1, data: { type: "user-message", content: "stop me", model: "m" } },
      { id: 2, data: { type: "text-delta", delta: "Going" } },
    ];
    // Live: the first attempt's error frame, the continue's records, then the
    // abort's cancellation.
    let live: ChatMessage[] = [];
    for (const record of failedTurn) live = applyRecord(live, "t1", record);
    live = applyTurnError(live, "t1", { code: "ERR_JOURNAL_WRITER_LOST", message: "writer lost" });
    for (const record of continued.slice(failedTurn.length)) live = applyRecord(live, "t1", record);
    for (const record of aborted) live = applyRecord(live, "t2", record);
    live = applyTurnStopped(live, "t2");

    const read = transcriptFromTurns([
      { turnId: "t1", status: "finished", error: null, records: continued },
      {
        turnId: "t2",
        status: "aborted",
        error: { code: "ERR_INVOKE_CANCELLED", message: "cancelled" },
        records: aborted,
      },
    ]);

    expect(read).toEqual(live);
    expect(read).toHaveLength(4);
    expect(read[1]).toMatchObject({
      completed: true,
      lastRecordId: 7,
      parts: [{ kind: "text", text: "Start" }, { kind: "text", text: "Next call" }, { kind: "continued" }, { kind: "text", text: "Resumed." }],
    });
    expect(read[3]).toMatchObject({ stopped: true, pending: false });
  });

  it("renders each turn as a user bubble and an ordered reply, reasoning included", () => {
    const [user, reply, nextUser, failed] = transcriptFromTurns(turns);

    expect(user).toEqual({ id: "t1:user", role: "user", text: "build it" });
    expect(reply).toMatchObject({
      id: "t1",
      role: "assistant",
      pending: false,
      completed: true,
      parts: [
        { kind: "thinking", text: "plan" },
        {
          kind: "tool",
          tool: {
            toolCallId: "call_1",
            name: "write_file",
            state: "done",
            output: "wrote a.yaml\ncheck: clean",
            checkExitCode: 0,
            diagnostics: [],
          },
        },
        { kind: "text", text: "Wrote it." },
      ],
    });
    expect(nextUser).toEqual({ id: "t2:user", role: "user", text: "again" });
    // A model call's end is a boundary: the next call's text is its own segment.
    expect(failed).toMatchObject({
      id: "t2",
      pending: false,
      error: "refused",
      errorCode: "ERR_OPENAI_REQUEST_FAILED",
      parts: [
        { kind: "text", text: "Start" },
        { kind: "text", text: "Next call" },
      ],
    });
  });

  it("renders the full transcript from the agent alone, with nothing in browser storage", async () => {
    localStorage.clear();
    // The same conversation, split by the server across two pages mid-turn.
    const pages: RecordsPage[] = [
      {
        turns: [{ turnId: "t1", status: "finished", error: null, records: toolTurn.slice(0, 4) }],
        next: { fromTurn: "t1", fromId: 4 },
      },
      {
        turns: [
          { turnId: "t1", status: "finished", error: null, records: toolTurn.slice(4) },
          turns[1],
        ],
        next: null,
      },
    ];
    const cursors: unknown[] = [];

    const read = await readConversation(async (cursor) => {
      cursors.push(cursor);
      return pages[cursors.length - 1];
    });

    expect(cursors).toEqual([null, { fromTurn: "t1", fromId: 4 }]);
    expect(transcriptFromTurns(read)).toEqual(transcriptFromTurns(turns));
  });

  it("folds a title failure and a context summary into the turn that journaled them, in stream order", () => {
    const messages = transcriptFromTurns([
      {
        turnId: "t3",
        status: "finished",
        error: null,
        records: [
          { id: 1, data: { type: "user-message", content: "go on", model: "m" } },
          { id: 2, data: { type: "conversation-title", error: { code: "ERR_TITLE_EMPTY", message: "empty title" } } },
          { id: 3, data: { type: "context-summary", throughTurnId: "t1", summary: "Earlier: a server.", model: "m" } },
          { id: 4, data: { type: "text-delta", delta: "Done." } },
          { id: 5, data: { type: "finish", finishReason: "stop" } },
        ],
      },
    ]);

    expect(messages[1]).toMatchObject({
      parts: [
        { kind: "title-error", error: { code: "ERR_TITLE_EMPTY", message: "empty title" } },
        { kind: "summary", throughTurnId: "t1", summary: "Earlier: a server." },
        { kind: "text", text: "Done." },
      ],
    });
  });

  it("folds a failed summarization and a title record with neither title nor error into nothing", () => {
    const plain: JournalRecord[] = [
      { id: 1, data: { type: "user-message", content: "go on", model: "m" } },
      { id: 4, data: { type: "text-delta", delta: "Done." } },
    ];
    const withDegenerate: JournalRecord[] = [
      plain[0],
      { id: 2, data: { type: "conversation-title", model: "m", usage: { totalTokens: 3 } } },
      {
        id: 3,
        data: {
          type: "context-summary",
          throughTurnId: "t1",
          error: { code: "ERR_OPENAI_REQUEST_FAILED", message: "down" },
          model: "m",
        },
      },
      plain[1],
    ];
    const turn = (records: JournalRecord[]): TurnRecords => ({ turnId: "t3", status: "finished", error: null, records });

    const { lastRecordId, ...folded } = transcriptFromTurns([turn(withDegenerate)])[1] as AssistantMessage;
    const { lastRecordId: plainLast, ...expected } = transcriptFromTurns([turn(plain)])[1] as AssistantMessage;
    expect([lastRecordId, plainLast]).toEqual([4, 4]);
    expect(folded).toEqual(expected);
  });
});
