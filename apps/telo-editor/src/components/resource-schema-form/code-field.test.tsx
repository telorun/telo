import { makeTaggedSentinel } from "@telorun/templating";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeField } from "./code-field";
import type { JsonSchemaProperty } from "./types";

// The real editor is Monaco, which does not run under jsdom. Swap it for a
// plain textarea that mirrors the value/onValueChange contract so we can
// assert what text CodeField hands down and what it emits back.
vi.mock("../code-editor", () => ({
  CodeEditor: ({
    value,
    onValueChange,
  }: {
    value: string;
    onValueChange: (next: string) => void;
  }) => (
    <textarea
      data-testid="code-editor"
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
    />
  ),
}));

afterEach(() => {
  cleanup();
});

const prop: JsonSchemaProperty = {
  type: "string",
  contentMediaType: "application/sql",
  "x-telo-widget": "code",
};

describe("CodeField with a !literal sentinel", () => {
  it("displays the sentinel source text, not '[object Object]'", () => {
    const value = makeTaggedSentinel("literal", "CREATE TABLE t (id INTEGER);");
    render(
      <CodeField prop={prop} value={value} onValueChange={() => {}} onBlur={() => {}} />,
    );
    const editor = screen.getByTestId("code-editor") as HTMLTextAreaElement;
    expect(editor.value).toBe("CREATE TABLE t (id INTEGER);");
  });

  it("re-wraps edits with the same engine so the tag round-trips", () => {
    const value = makeTaggedSentinel("literal", "SELECT 1;");
    const onValueChange = vi.fn();
    render(
      <CodeField prop={prop} value={value} onValueChange={onValueChange} onBlur={() => {}} />,
    );
    fireEvent.change(screen.getByTestId("code-editor"), { target: { value: "SELECT 2;" } });
    expect(onValueChange).toHaveBeenCalledWith(makeTaggedSentinel("literal", "SELECT 2;"));
  });

  it("passes plain string values through untouched", () => {
    const onValueChange = vi.fn();
    render(
      <CodeField prop={prop} value="SELECT 1;" onValueChange={onValueChange} onBlur={() => {}} />,
    );
    const editor = screen.getByTestId("code-editor") as HTMLTextAreaElement;
    expect(editor.value).toBe("SELECT 1;");
    fireEvent.change(editor, { target: { value: "SELECT 2;" } });
    expect(onValueChange).toHaveBeenCalledWith("SELECT 2;");
  });
});
