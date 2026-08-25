import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeTaggedSentinel } from "@telorun/templating";
import { isValueOrReferenceSlot, ValueOrReferenceField } from "./value-or-reference-field";
import type { JsonSchemaProperty, ResolvedResourceOption } from "./types";

afterEach(() => {
  cleanup();
});

// A declared column's `type:`: a storage class from the backend's closed
// vocabulary, or a reference to a declared enum.
const columnType: JsonSchemaProperty = {
  oneOf: [
    { title: "Storage class", type: "string", enum: ["text", "uuid", "bigint"] },
    { title: "Enum type", type: "object", "x-telo-ref": { kind: "Postgres.Enum", use: "schema" } },
  ],
} as unknown as JsonSchemaProperty;

// The same slot with an OPEN value branch and two permitted kinds.
const openType: JsonSchemaProperty = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      "x-telo-ref": { kind: ["Postgres.Enum", "Postgres.Domain"], use: "schema" },
    },
  ],
} as unknown as JsonSchemaProperty;

const enums: ResolvedResourceOption[] = [
  { kind: "Postgres.Enum", name: "messageRole" } as ResolvedResourceOption,
  { kind: "Postgres.Domain", name: "emailAddress" } as ResolvedResourceOption,
];

function Harness({ prop, initial }: { prop?: JsonSchemaProperty; initial?: unknown }) {
  const [value, setValue] = useState<unknown>(initial);
  return (
    <>
      <ValueOrReferenceField
        prop={prop ?? columnType}
        value={value}
        onValueChange={setValue}
        onBlur={() => {}}
        resolvedResources={enums}
      />
      <output data-testid="written">{JSON.stringify(value ?? null)}</output>
    </>
  );
}

describe("isValueOrReferenceSlot", () => {
  it("recognises a closed value branch beside a reference branch", () => {
    expect(isValueOrReferenceSlot(columnType)).toBe(true);
  });

  it("recognises an OPEN scalar value branch too — a JSON editor is not a scalar", () => {
    expect(isValueOrReferenceSlot(openType)).toBe(true);
  });

  it("declines a reference slot whose constraint is the node's own", () => {
    // JS.Script's `inputType`: a node-level ref plus an inline object — the
    // reference/inline toggle's shape, not this one.
    expect(
      isValueOrReferenceSlot({
        "x-telo-ref": "telo#Type",
        oneOf: [{ type: "string" }, { type: "object", additionalProperties: true }],
      } as unknown as JsonSchemaProperty),
    ).toBe(false);
  });
});

describe("a closed value branch", () => {
  it("offers the value vocabulary plus one entry per accepted kind", () => {
    render(<Harness />);
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Set…", "text", "uuid", "bigint", "enum"]);
  });

  it("writes the scalar and shows no picker", async () => {
    render(<Harness />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "text");
    expect(screen.getByTestId("written").textContent).toBe('"text"');
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });

  it("swaps to the reference picker on the kind entry, writing nothing yet", async () => {
    render(<Harness />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "::ref:Postgres.Enum");
    expect(screen.getByTestId("written").textContent).toBe("null");
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("writes a `!ref` sentinel once a target is picked", async () => {
    render(<Harness />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "::ref:Postgres.Enum");
    const [, picker] = screen.getAllByRole("combobox");
    await userEvent.selectOptions(picker, "Postgres.Enum.messageRole");
    expect(JSON.parse(screen.getByTestId("written").textContent!)).toEqual(
      makeTaggedSentinel("ref", "messageRole"),
    );
  });

  it("reads the mode back from an existing reference", () => {
    render(<Harness initial={makeTaggedSentinel("ref", "messageRole")} />);
    const [mode] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(mode.value).toBe("::ref:Postgres.Enum");
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("reads the mode back from an existing scalar", () => {
    render(<Harness initial="uuid" />);
    const [mode] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(mode.value).toBe("uuid");
    expect(screen.getAllByRole("combobox")).toHaveLength(1);
  });
});

describe("an open value branch", () => {
  it("offers one `value` entry and renders a scalar input for it", async () => {
    render(<Harness prop={openType} />);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Set…",
      "value",
      "enum",
      "domain",
    ]);
    await userEvent.selectOptions(screen.getByRole("combobox"), "::value");
    await userEvent.type(screen.getByRole("textbox"), "citext");
    expect(screen.getByTestId("written").textContent).toBe('"citext"');
  });
});

describe("a multi-kind reference branch", () => {
  it("reads the kind off the reference rather than assuming the first", () => {
    render(<Harness prop={openType} initial={makeTaggedSentinel("ref", "emailAddress")} />);
    const [mode] = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(mode.value).toBe("::ref:Postgres.Domain");
  });
});
