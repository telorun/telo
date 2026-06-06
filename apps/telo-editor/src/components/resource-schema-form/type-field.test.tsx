import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TypeField } from "./type-field";
import type { JsonSchemaProperty, TypeKindOption } from "./types";

afterEach(() => {
  cleanup();
});

// A field shaped like JS.Script's inputType: a Telo.Type ref that also permits
// an inline object.
const typeFieldProp: JsonSchemaProperty = {
  "x-telo-ref": "telo#Type",
  oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
};

// The std/type#JsonSchema definition schema — its `schema` field carries the
// inline JSON Schema body.
const jsonSchemaKind: TypeKindOption = {
  kind: "Type.JsonSchema",
  schema: {
    type: "object",
    properties: { schema: { type: "object", title: "Schema" } },
    required: ["schema"],
  },
};

function Harness({
  typeKinds,
  onValueChange,
}: {
  typeKinds: TypeKindOption[];
  onValueChange?: (next: unknown) => void;
}) {
  const [value, setValue] = useState<unknown>(undefined);
  return (
    <TypeField
      prop={typeFieldProp}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
      onBlur={() => {}}
      resolvedResources={[]}
      typeKinds={typeKinds}
    />
  );
}

describe("TypeField inline editing", () => {
  it("picking an imported type kind produces an inline { kind } resource", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Harness typeKinds={[jsonSchemaKind]} onValueChange={onValueChange} />);

    await user.click(screen.getByRole("button", { name: "Inline" }));
    await user.selectOptions(screen.getByRole("combobox"), "Type.JsonSchema");

    expect(onValueChange).toHaveBeenLastCalledWith({ kind: "Type.JsonSchema" });
    // The picked kind's body form renders (its `schema` field).
    expect(screen.getByText("Schema")).toBeInTheDocument();
  });

  it("offers no inline editing when no type kinds are imported", async () => {
    const user = userEvent.setup();
    render(<Harness typeKinds={[]} />);

    await user.click(screen.getByRole("button", { name: "Inline" }));

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(/Import a type system/)).toBeInTheDocument();
  });
});
