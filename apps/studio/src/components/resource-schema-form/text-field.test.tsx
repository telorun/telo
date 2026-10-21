import { expandManifestFragments, manifestFragmentRef } from "@telorun/analyzer";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceSchemaForm } from "./index";

afterEach(() => {
  cleanup();
});

/** A kind's schema holding a `Text` field, expanded as the loader expands every
 *  manifest: the fragment inlined, the recursive `Message` it holds reached by a
 *  document-local reference into the schema's own `$defs`. */
function textKindSchema(): Record<string, unknown> {
  const definition: Record<string, any> = {
    kind: "Telo.Definition",
    metadata: { name: "Card" },
    capability: "Telo.Type",
    schema: {
      type: "object",
      properties: { label: { $ref: manifestFragmentRef("Text") } },
    },
  };
  expandManifestFragments(definition);
  return definition.schema;
}

function Harness({ initial }: { initial: unknown }) {
  const [values, setValues] = useState<Record<string, unknown>>({ label: initial });
  return (
    <>
      <ResourceSchemaForm schema={textKindSchema()} values={values} onChange={setValues} />
      <output data-testid="written">{JSON.stringify(values.label ?? null)}</output>
    </>
  );
}

const written = () => JSON.parse(screen.getByTestId("written").textContent ?? "null");

describe("a Text field", () => {
  it("edits a pattern as text", async () => {
    render(<Harness initial="Hello" />);
    const input = screen.getByDisplayValue("Hello");
    await userEvent.type(input, " {{$name}");
    expect(written()).toBe("Hello {$name}");
  });

  it("draws a text with a context as its two members", () => {
    render(<Harness initial={{ text: "Open", context: "verb" }} />);
    expect(screen.getByRole("tab", { name: "text, context", selected: true })).toBeTruthy();
    expect(screen.getByDisplayValue("Open")).toBeTruthy();
    expect(screen.getByDisplayValue("verb")).toBeTruthy();
  });

  it("switches a pattern to a plural selection", async () => {
    render(<Harness initial="Hello" />);
    await userEvent.click(screen.getByRole("tab", { name: "plural, cases" }));
    expect(written()).toEqual({});
    expect(screen.getByRole("tab", { name: "plural, cases", selected: true })).toBeTruthy();
    expect(screen.getByText("plural")).toBeTruthy();
    expect(screen.getByText("cases")).toBeTruthy();
  });
});
