import { withSchemaFragments, manifestFragmentRef } from "@telorun/analyzer";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldControl, isSchemaFragmentSlot } from "./field-control";
import type { JsonSchemaProperty } from "./types";

/** A slot holding author-written JSON Schema carries a `$ref` to the shared
 *  fragment and no `type` of its own, so `inferType` falls through to "string".
 *  Without the fragment check ahead of it, a kind's `schema:` block would render
 *  as a single-line text input. */

afterEach(() => {
  cleanup();
});

function schemaSlot(fragment: string): JsonSchemaProperty {
  const wrapper = withSchemaFragments({
    type: "object",
    properties: { schema: { $ref: manifestFragmentRef(fragment) } },
  }) as Record<string, any>;
  return wrapper.properties.schema as JsonSchemaProperty;
}

describe("a schema-fragment slot", () => {
  it("is recognised through the stamp for both vocabularies", () => {
    expect(isSchemaFragmentSlot(schemaSlot("KindSchema"))).toBe(true);
    expect(isSchemaFragmentSlot(schemaSlot("JsonSchema7"))).toBe(true);
    expect(isSchemaFragmentSlot({ type: "object" } as JsonSchemaProperty)).toBe(false);
  });

  it("renders the schema editor rather than a scalar input", () => {
    render(
      <FieldControl
        rootFieldName="schema"
        fieldPath="schema"
        prop={schemaSlot("KindSchema")}
        value={{ type: "object", properties: { name: { type: "string" } } }}
        onValueChange={() => {}}
        onFieldBlur={() => {}}
        resolvedResources={[]}
      />,
    );
    // The schema editor lists the declared property by name; a scalar input
    // would have rendered the whole object as text.
    expect(screen.getByDisplayValue("name")).toBeTruthy();
  });
});
