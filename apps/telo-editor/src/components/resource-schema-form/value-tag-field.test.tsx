import { makeTaggedSentinel } from "@telorun/templating";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { offeredValueTags } from "./value-tag";
import { ValueTagField } from "./value-tag-field";

afterEach(cleanup);

const EVAL_STRING = offeredValueTags({ type: "string" }, "compile");

function renderField(value: unknown, onValueChange = vi.fn()) {
  render(
    <ValueTagField
      options={EVAL_STRING}
      evalMode="compile"
      value={value}
      onValueChange={onValueChange}
      onBlur={() => {}}
    >
      <input data-testid="plain" />
    </ValueTagField>,
  );
  return onValueChange;
}

describe("ValueTagField", () => {
  it("falls through to the ordinary widget for an untagged value", () => {
    renderField("plain string");
    expect(screen.getByTestId("plain")).toBeDefined();
    expect(screen.getByTitle("How this value is written").textContent).toContain("value");
  });

  it("edits a tagged value's source, and shows which tag it carries", () => {
    renderField(makeTaggedSentinel("literal", "Hello ${{ x }}"));
    expect(screen.getByDisplayValue("Hello ${{ x }}")).toBeDefined();
    expect(screen.getByTitle("How this value is written").textContent).toContain("!literal");
    // The tagged editor replaces the ordinary widget rather than sitting beside
    // it — the value under a tag is not the value the widget was built for.
    expect(screen.queryByTestId("plain")).toBeNull();
  });

  it("writes a SENTINEL, never a raw `${{ }}` string", async () => {
    // The defect the old CEL toggle made unavoidable: it wrote the one spelling
    // manifests must never carry, which the round trip has mangled into a
    // broken `!ref`.
    const onValueChange = renderField(makeTaggedSentinel("cel", ""));
    await userEvent.type(screen.getByRole("textbox"), "x");
    expect(onValueChange).toHaveBeenCalledWith(makeTaggedSentinel("cel", "x"));
  });

  it("qualifies only `!cel` by when it is evaluated", () => {
    // The same expression means different things at load and per invocation.
    // `!literal` is never evaluated, so saying "compile" beside it would
    // describe the field rather than the value.
    renderField(makeTaggedSentinel("cel", "variables.port"));
    expect(screen.getByText("compile")).toBeDefined();
    cleanup();
    renderField(makeTaggedSentinel("literal", "text"));
    expect(screen.queryByText("compile")).toBeNull();
  });

  it("reports a bad embed path as it is typed", () => {
    render(
      <ValueTagField
        options={offeredValueTags({ type: "string" }, null)}
        evalMode={null}
        value={makeTaggedSentinel("include-text", "../outside.txt")}
        onValueChange={vi.fn()}
        onBlur={() => {}}
      >
        <input data-testid="plain" />
      </ValueTagField>,
    );
    // Confinement is a pure string check, so the editor can decide it — finding
    // out from a diagnostic on another line is finding out too late.
    expect(screen.getByDisplayValue("../outside.txt")).toBeDefined();
    expect(screen.getByText(/module/i)).toBeDefined();
  });

  it("re-selects the tag the manifest actually carries", () => {
    // An edit from Source view, the agent or an undo is authoritative; the
    // picker follows it rather than holding the selection it was left on.
    const { rerender } = render(
      <ValueTagField
        options={EVAL_STRING}
        evalMode="compile"
        value={makeTaggedSentinel("cel", "a")}
        onValueChange={vi.fn()}
        onBlur={() => {}}
      >
        <input data-testid="plain" />
      </ValueTagField>,
    );
    expect(screen.getByTitle("How this value is written").textContent).toContain("!cel");
    rerender(
      <ValueTagField
        options={EVAL_STRING}
        evalMode="compile"
        value="now plain"
        onValueChange={vi.fn()}
        onBlur={() => {}}
      >
        <input data-testid="plain" />
      </ValueTagField>,
    );
    expect(screen.getByTestId("plain")).toBeDefined();
  });
});
