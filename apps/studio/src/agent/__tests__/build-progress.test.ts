import { describe, expect, it } from "vitest";

import { buildProgress } from "../build-progress";
import type { AssistantMessage, ChatMessage, FileChange, ToolCallView } from "../types";

const ask = (text: string): ChatMessage => ({ id: "u:t1", role: "user", text });
const reply = (over: Partial<AssistantMessage>): AssistantMessage => ({
  id: "t1",
  role: "assistant",
  parts: [],
  ...over,
});
const change = (path: string, status: FileChange["status"]): FileChange => ({
  path,
  status,
  before: null,
  after: null,
  added: null,
  removed: null,
});
const tool = (over: Partial<ToolCallView>): ToolCallView => ({
  toolCallId: "c1",
  name: "write_file",
  state: "done",
  ...over,
});

describe("the empty workspace's view of the latest turn", () => {
  it("is nothing while the conversation is empty and idle", () => {
    expect(buildProgress([], "idle", null)).toBeNull();
  });

  it("follows the launch before the conversation has a message", () => {
    expect(buildProgress([], "launching", null)?.phase).toEqual({ kind: "starting" });
    expect(buildProgress([ask("x")], "seeding", null)?.phase).toEqual({ kind: "preparing" });
  });

  it("names the request without the editor selections it carried", () => {
    const text = "Build a todo app\n\n```telo-selection app/telo.yaml:1-2\na\nb\n```";
    expect(buildProgress([ask(text)], "streaming", null)?.request).toBe("Build a todo app");
  });

  it("names the step the running turn is on", () => {
    const running = tool({ name: "get_kinds", state: "running", args: { ref: "ui" } });
    const progress = buildProgress(
      [ask("x"), reply({ pending: true, parts: [{ kind: "text", text: "Looking" }, { kind: "tool", tool: running }] })],
      "streaming",
      null,
    );
    expect(progress?.phase).toEqual({ kind: "working", step: { kind: "tool", tool: running } });
  });

  it("lists the files the turn left written, in the order first written", () => {
    const parts = [
      { kind: "tool" as const, tool: tool({ changes: [change("app/telo.yaml", "created")] }) },
      { kind: "tool" as const, tool: tool({ changes: [change("app/scratch.yaml", "created")] }) },
      { kind: "tool" as const, tool: tool({ changes: [change("app/telo.yaml", "modified")] }) },
      { kind: "tool" as const, tool: tool({ changes: [change("app/scratch.yaml", "deleted")] }) },
      { kind: "tool" as const, tool: tool({ state: "running", changes: [change("app/later.yaml", "created")] }) },
    ];
    expect(buildProgress([ask("x"), reply({ pending: true, parts })], "streaming", null)?.files).toEqual([
      "app/telo.yaml",
    ]);
  });

  it("says how an ended turn ended", () => {
    const outcome = (m: AssistantMessage, status: "idle" | "error" = "idle", error: string | null = null) => {
      const phase = buildProgress([ask("x"), m], status, error)?.phase;
      return phase?.kind === "ended" ? phase.outcome : phase;
    };
    const question = '```telo-questions\n{"questions":[{"question":"Which database?"}]}\n```';
    expect(outcome(reply({ completed: true, parts: [{ kind: "text", text: question }] }))).toEqual({ kind: "question" });
    expect(outcome(reply({ completed: true, limit: "max-steps" }))).toEqual({ kind: "max-steps" });
    expect(outcome(reply({ stopped: true }))).toEqual({ kind: "stopped" });
    expect(outcome(reply({ error: "Model refused" }))).toEqual({ kind: "failed", message: "Model refused" });
    expect(outcome(reply({}), "error", "Agent unreachable")).toEqual({ kind: "failed", message: "Agent unreachable" });
    expect(outcome(reply({ completed: true, parts: [{ kind: "text", text: "Done." }] }))).toEqual({ kind: "replied" });
    expect(outcome(reply({ completed: true }), "idle", "Failed to reflect the agent's workspace changes")).toEqual({
      kind: "failed",
      message: "Failed to reflect the agent's workspace changes",
    });
  });

  it("reports a send that never became a turn as a failure", () => {
    expect(buildProgress([ask("x")], "error", "At capacity")?.phase).toEqual({
      kind: "ended",
      outcome: { kind: "failed", message: "At capacity" },
    });
  });
});
