import { describe, expect, it } from "vitest";

import { transcriptFromTurns } from "../records";
import { exportJson, exportMarkdown, type ConversationExport } from "../transcript-export";
import type { Conversation, TurnRecords } from "../types";

const conversation: Conversation = {
  id: "c1",
  title: "Build a server",
  createdAt: "2026-09-28T10:00:00.000Z",
  updatedAt: "2026-09-28T10:05:00.000Z",
  model: "m",
  messageCount: 4,
  totalTokens: 1234,
  archived: false,
  revision: 7,
};

const turns: TurnRecords[] = [
  {
    turnId: "t1",
    status: "finished",
    error: null,
    records: [
      { id: 1, data: { type: "user-message", content: "build it", model: "m" } },
      { id: 2, data: { type: "reasoning-delta", delta: "plan it" } },
      { id: 3, data: { type: "tool-call", toolCall: { id: "a", name: "write_file", arguments: { path: "a.yaml" } } } },
      {
        id: 4,
        data: {
          type: "tool-result",
          toolResult: { toolCallId: "a", name: "write_file", content: "wrote a.yaml", output: { path: "a.yaml" } },
        },
      },
      { id: 5, data: { type: "tool-call", toolCall: { id: "b", name: "telo_check", arguments: { path: "a.yaml" } } } },
      {
        id: 6,
        data: { type: "tool-result", toolResult: { toolCallId: "b", name: "telo_check", content: "```boom```", error: true } },
      },
      { id: 7, data: { type: "text-delta", delta: "Done." } },
      { id: 8, data: { type: "finish", finishReason: "stop" } },
    ],
  },
  {
    turnId: "t2",
    status: "failed",
    error: { code: "ERR_CONTEXT_COMPACTION_FAILED", message: "Compacting failed" },
    records: [
      { id: 1, data: { type: "user-message", content: "more", model: "m" } },
      { id: 2, data: { type: "context-summary", throughTurnId: "t1", summary: "A server was built.", model: "m" } },
    ],
  },
];

const agent = { name: "AuthoringAgent", version: "0.10.0", promptId: "ab12", auth: "bearer" };

describe("conversation export", () => {
  it("JSON carries the agent, the conversation and the records verbatim, folding back into the same transcript", () => {
    const doc = JSON.parse(exportJson(agent, conversation, turns)) as ConversationExport;

    expect(doc.agent).toEqual({ name: "AuthoringAgent", version: "0.10.0", promptId: "ab12" });
    expect(doc.conversation).toEqual(conversation);
    expect(transcriptFromTurns(doc.turns)).toEqual(transcriptFromTurns(turns));
  });

  it("Markdown holds every tool call with its arguments and what the model received", () => {
    const md = exportMarkdown(conversation, turns);

    expect(md.startsWith("# Build a server\n\nCreated 2026-09-28T10:00:00.000Z · Updated 2026-09-28T10:05:00.000Z · Model m · 1234 tokens · c1")).toBe(true);
    expect(md).toContain('**Tool `write_file`**\n\n```json\n{\n  "path": "a.yaml"\n}\n```\n\n```text\nwrote a.yaml\n```');
    expect(md).toContain("**Tool `telo_check`** (failed)");
    expect(md).toContain("````text\n```boom```\n````");
    expect(md).toContain("> plan it");
    expect(md).toContain("--- Earlier turns were summarized for the agent ---\n\n> A server was built.");
    expect(md).toContain("Turn failed: ERR_CONTEXT_COMPACTION_FAILED — Compacting failed");
    expect(md).not.toContain('"output"');
  });

  it("leaves a failed summarization and an unapplied title out of every section, the turn's error line reporting it", () => {
    const failed: TurnRecords = {
      turnId: "t3",
      status: "failed",
      error: { code: "ERR_CONTEXT_COMPACTION_FAILED", message: "Compacting failed" },
      records: [
        { id: 1, data: { type: "user-message", content: "go on", model: "m" } },
        { id: 2, data: { type: "conversation-title", model: "m" } },
        {
          id: 3,
          data: { type: "context-summary", throughTurnId: "t1", error: { code: "ERR_X", message: "down" }, model: "m" },
        },
      ],
    };

    const md = exportMarkdown(conversation, [failed]);

    expect(md.slice(md.indexOf("## You"))).toBe(
      "## You\n\ngo on\n\n## Agent\n\nTurn failed: ERR_CONTEXT_COMPACTION_FAILED — Compacting failed\n",
    );
  });
});
