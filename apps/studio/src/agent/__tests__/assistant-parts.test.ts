import { describe, expect, it } from "vitest";

import { appendDelta, appendToolCall, settleToolCall } from "../assistant-parts";
import type { AssistantPart, ToolCallView } from "../types";

const call = (toolCallId: string): ToolCallView => ({ toolCallId, name: "write_file", state: "running" });

describe("assistant parts", () => {
  it("keeps the stream's order, extending a segment only while its kind continues", () => {
    let parts: AssistantPart[] = [];
    parts = appendDelta(parts, "thinking", "Look at ");
    parts = appendDelta(parts, "thinking", "the app.");
    parts = appendToolCall(parts, call("a"));
    parts = appendDelta(parts, "thinking", "Now the library.");
    parts = appendToolCall(parts, call("b"));
    parts = appendDelta(parts, "text", "Done");
    parts = appendDelta(parts, "text", ".");

    expect(parts).toEqual([
      { kind: "thinking", text: "Look at the app." },
      { kind: "tool", tool: call("a") },
      { kind: "thinking", text: "Now the library." },
      { kind: "tool", tool: call("b") },
      { kind: "text", text: "Done." },
    ]);
  });

  it("settles a tool result on its own call, in place", () => {
    const parts: AssistantPart[] = [
      { kind: "tool", tool: call("a") },
      { kind: "text", text: "next" },
      { kind: "tool", tool: call("b") },
    ];
    expect(settleToolCall(parts, { toolCallId: "a" }, (t) => ({ ...t, state: "done" }))).toEqual([
      { kind: "tool", tool: { ...call("a"), state: "done" } },
      { kind: "text", text: "next" },
      { kind: "tool", tool: call("b") },
    ]);
  });
});
