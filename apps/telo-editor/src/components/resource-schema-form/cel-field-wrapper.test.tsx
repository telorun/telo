import { makeTaggedSentinel } from "@telorun/templating";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CelFieldWrapper } from "./cel-field-wrapper";

afterEach(() => {
  cleanup();
});

describe("CelFieldWrapper with tagged sentinels", () => {
  it("renders a !literal sentinel as readable source text, not the raw object", () => {
    const value = makeTaggedSentinel("literal", "Hello ${{ x }}");
    render(
      <CelFieldWrapper
        evalMode="compile"
        value={value}
        onValueChange={() => {}}
        onBlur={() => {}}
      >
        <input data-testid="static-input" />
      </CelFieldWrapper>,
    );
    // The input should carry the raw source text, NOT a "[object Object]"
    // serialization of the sentinel.
    const input = screen.getByDisplayValue("Hello ${{ x }}");
    expect(input).toBeDefined();
    expect(input.getAttribute("readonly")).not.toBeNull();
    // The literal-mode chrome surfaces the engine name as a pill.
    expect(screen.getByText("!literal")).toBeDefined();
    // Static-mode children are NOT rendered for literal sentinels.
    expect(screen.queryByTestId("static-input")).toBeNull();
  });

  it("renders a !cel sentinel in expression mode with the source preloaded", () => {
    const value = makeTaggedSentinel("cel", "variables.port");
    render(
      <CelFieldWrapper
        evalMode="compile"
        value={value}
        onValueChange={() => {}}
        onBlur={() => {}}
      >
        <input data-testid="static-input" />
      </CelFieldWrapper>,
    );
    // The expression-mode input shows the inner source.
    const input = screen.getByDisplayValue("variables.port");
    expect(input).toBeDefined();
    // Children are hidden in expression mode.
    expect(screen.queryByTestId("static-input")).toBeNull();
  });

  it("falls through to children for plain primitive values", () => {
    render(
      <CelFieldWrapper
        evalMode="compile"
        value={"plain string"}
        onValueChange={() => {}}
        onBlur={() => {}}
      >
        <input data-testid="static-input" defaultValue="plain string" />
      </CelFieldWrapper>,
    );
    expect(screen.getByTestId("static-input")).toBeDefined();
  });
});
