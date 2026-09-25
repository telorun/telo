import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MessageBlock } from "./MessageBlock";
import type { AssistantMessage, AssistantPart } from "@/agent";

afterEach(() => {
  cleanup();
});

const tool = (name: string): AssistantPart => ({
  kind: "tool",
  tool: { toolCallId: name, name, state: "done" },
});

const renderTurn = (parts: AssistantPart[], over: Partial<AssistantMessage> = {}) =>
  render(
    <MessageBlock
      message={{ id: "a", role: "assistant", parts, ...over }}
      questionCards
      answerable
      onAnswer={() => undefined}
    />,
  );

const questions = (label: string) =>
  "```telo-questions\n" +
  JSON.stringify({ questions: [{ id: label, question: `Pick ${label}?`, options: [{ label }] }] }) +
  "\n```";

describe("MessageBlock", () => {
  it("renders thought, card, thought, card, text in the order they streamed", () => {
    const { container } = renderTurn(
      [
        { kind: "thinking", text: "first thought" },
        tool("read_file"),
        { kind: "thinking", text: "second thought" },
        tool("write_file"),
        { kind: "text", text: "All done." },
      ],
      { completed: true },
    );

    const text = container.textContent ?? "";
    const order = ["Thought process", "read_file", "Thought process", "write_file", "All done."];
    let from = 0;
    for (const expected of order) {
      const at = text.indexOf(expected, from);
      expect(at, expected).toBeGreaterThanOrEqual(from);
      from = at + expected.length;
    }
  });

  it("keeps only the thinking segment still streaming open", () => {
    renderTurn(
      [{ kind: "thinking", text: "first thought" }, tool("read_file"), { kind: "thinking", text: "second thought" }],
      { pending: true },
    );

    expect(screen.queryByText("first thought")).toBeNull();
    expect(screen.getByText("second thought")).toBeTruthy();
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("reads questions from the last text segment only", () => {
    renderTurn(
      [{ kind: "text", text: questions("Alpha") }, tool("read_file"), { kind: "text", text: questions("Beta") }],
      { completed: true },
    );

    expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull();
  });
});
