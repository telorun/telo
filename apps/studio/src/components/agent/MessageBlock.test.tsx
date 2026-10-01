import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  it("renders thought, card, thought, card, text in the order they streamed", async () => {
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
    // The four steps of an ended turn are folded into one group.
    await userEvent.click(screen.getByRole("button", { name: /4 steps/ }));

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

  it("folds two or more steps in a row into one group: open while the turn streams, folded once it ends", async () => {
    const steps: AssistantPart[] = [
      { kind: "text", text: "On it." },
      { kind: "thinking", text: "plan" },
      tool("read_file"),
      { kind: "tool", tool: { toolCallId: "x", name: "write_file", state: "error", output: "ERR_FILE_NOT_TEXT" } },
      { kind: "tool", tool: { toolCallId: "r", name: "run_manifest", state: "done", run: { exitCode: 1, output: "", messages: "" } } },
      { kind: "text", text: "Done." },
      tool("list_dir"),
    ];

    renderTurn(steps, { pending: true });
    expect(screen.getByRole("button", { name: "4 steps · 2 failed" })).toBeTruthy();
    expect(screen.getByText("read_file")).toBeTruthy();
    cleanup();

    renderTurn(steps, { completed: true });
    expect(screen.queryByText("read_file")).toBeNull();
    // A single step between two pieces of the reply stays as it is.
    expect(screen.getByText("list_dir")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "4 steps · 2 failed" }));
    expect(screen.getByText("read_file")).toBeTruthy();
  });

  it("reads questions from the last text segment only", () => {
    renderTurn(
      [{ kind: "text", text: questions("Alpha") }, tool("read_file"), { kind: "text", text: questions("Beta") }],
      { completed: true },
    );

    expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull();
  });

  it("shows a write whose check failed as an error listing its diagnostics", () => {
    renderTurn(
      [
        {
          kind: "tool",
          tool: {
            toolCallId: "w",
            name: "write_file",
            state: "done",
            output: "wrote app/telo.yaml\napp/telo.yaml:3:5 SCHEMA_VIOLATION bad field",
            checkExitCode: 1,
            diagnostics: [
              { file: "app/telo.yaml", line: 3, column: 5, severity: "error", code: "SCHEMA_VIOLATION", message: "bad field" },
              { file: "app/telo.yaml", line: 9, column: 1, severity: "error", message: "no code" },
            ],
          },
        },
      ],
      { completed: true },
    );

    expect(screen.getByText("Error", { selector: "h4" })).toBeTruthy();
    expect(screen.getByText("telo check exited with 1")).toBeTruthy();
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "app/telo.yaml:3:5 SCHEMA_VIOLATION bad field",
      "app/telo.yaml:9:1 no code",
    ]);
  });

  it("reads a failed turn's error by its code", () => {
    const shown = (errorCode: string) => {
      const { container } = renderTurn([], { error: "raw message", errorCode });
      const text = container.textContent;
      cleanup();
      return text;
    };

    expect(shown("ERR_JOURNAL_WRITER_LOST")).toBe("The agent restarted during this turn.");
    expect(shown("ERR_JOURNAL_KEY_REMOVED")).toBe("This turn was deleted.");
    expect(shown("ERR_OPENAI_REQUEST_FAILED")).toBe("raw message");
  });

  it("notes a conversation that could not be named, by code, without failing the turn", () => {
    const { container } = renderTurn(
      [{ kind: "title-error", error: { code: "ERR_TITLE_EMPTY", message: "empty title" } }, { kind: "text", text: "Done." }],
      { completed: true },
    );

    expect(container.textContent).toBe(
      "Couldn't name this conversation — ERR_TITLE_EMPTY: empty title. Rename it from the conversation list.Done.",
    );
  });
});
