import { afterEach, describe, expect, it } from "vitest";

import { LOCAL_PREFIXES } from "../../storage-keys";
import { loadChat, saveChat } from "../storage";
import type { ChatMessage, ToolCallView } from "../types";

const tool = (toolCallId: string): ToolCallView => ({ toolCallId, name: "write_file", state: "done" });
const chat = (messages: ChatMessage[]) => ({ messages, activeTurnId: null, lastEventId: 0 });

afterEach(() => {
  localStorage.clear();
});

describe("persisted transcript", () => {
  it("drops thinking before saving, keeping cards and text in their order", () => {
    saveChat("c1", chat([
      {
        id: "a",
        role: "assistant",
        parts: [
          { kind: "thinking", text: "plan" },
          { kind: "tool", tool: tool("1") },
          { kind: "text", text: "Now the library." },
          { kind: "thinking", text: "again" },
          { kind: "tool", tool: tool("2") },
          { kind: "text", text: "Done." },
        ],
        completed: true,
      },
    ]));

    expect(loadChat("c1").messages).toEqual([
      {
        id: "a",
        role: "assistant",
        parts: [
          { kind: "tool", tool: tool("1") },
          { kind: "text", text: "Now the library." },
          { kind: "tool", tool: tool("2") },
          { kind: "text", text: "Done." },
        ],
        completed: true,
      },
    ]);
  });

  // The three-bucket shape recorded no order; it loads in the one it rendered in.
  it("loads a transcript saved before parts existed, tools then text", () => {
    localStorage.setItem(
      LOCAL_PREFIXES.agentChat + "c2",
      JSON.stringify({
        messages: [
          { id: "u", role: "user", text: "build it", tools: [] },
          { id: "a", role: "assistant", text: "Done.", tools: [tool("1"), tool("2")], completed: true },
        ],
        activeTurnId: null,
        lastEventId: 0,
      }),
    );

    expect(loadChat("c2").messages).toEqual([
      { id: "u", role: "user", text: "build it" },
      {
        id: "a",
        role: "assistant",
        parts: [
          { kind: "tool", tool: tool("1") },
          { kind: "tool", tool: tool("2") },
          { kind: "text", text: "Done." },
        ],
        completed: true,
      },
    ]);
  });
});
