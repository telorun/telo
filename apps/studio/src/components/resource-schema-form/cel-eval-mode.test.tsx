import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { celEvalModeAtPointer, getCelEvalMode } from "./cel-utils";
import { ResourceSchemaForm } from "./index";
import { offeredValueTags } from "./value-tag";

afterEach(cleanup);

/**
 * A predicate field is typed by what it EVALUATES to — `when: type: boolean` —
 * so the plain widget for it is a checkbox. That is right for the untagged
 * value and useless on its own: the field exists to hold an expression, and the
 * editor offered no way to write one because it read `x-telo-eval` alone while
 * the analyzer also honours the region a field sits in.
 */

describe("getCelEvalMode", () => {
  it("takes an explicit annotation", () => {
    expect(getCelEvalMode({ "x-telo-eval": "compile" })).toBe("compile");
    expect(getCelEvalMode({ "x-telo-eval": "runtime" })).toBe("runtime");
  });

  it("reads a CEL region as runtime-evaluated", () => {
    expect(getCelEvalMode({ "x-telo-context": { type: "object" } })).toBe("runtime");
    expect(getCelEvalMode({ "x-telo-error-context": { type: "object" } })).toBe("runtime");
    expect(getCelEvalMode({ "x-telo-step-context": { invoke: "invoke" } })).toBe("runtime");
  });

  it("reads a step body as runtime-evaluated", () => {
    // The stamp sits on the array's ITEMS — the array is the slot.
    expect(getCelEvalMode({ type: "array", items: { "x-telo-fragment": "Step" } })).toBe(
      "runtime",
    );
  });

  it("lets an explicit annotation win inside a region", () => {
    expect(
      getCelEvalMode({ "x-telo-context": { type: "object" }, "x-telo-eval": "compile" }),
    ).toBe("compile");
  });

  it("falls back to the enclosing mode, and to nothing without one", () => {
    expect(getCelEvalMode({ type: "string" }, "compile")).toBe("compile");
    expect(getCelEvalMode({ type: "string" })).toBeNull();
  });
});

describe("celEvalModeAtPointer", () => {
  const schema = {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            returns: {
              type: "array",
              "x-telo-context": { type: "object" },
              items: { type: "object", properties: { when: { type: "boolean" } } },
            },
          },
        },
      },
      name: { type: "string" },
      settings: { $ref: "#/$defs/Settings" },
    },
    $defs: {
      Settings: {
        type: "object",
        "x-telo-eval": "compile",
        properties: { region: { type: "string" } },
      },
    },
  };

  it("carries an ancestor's region down to the pointer", () => {
    expect(celEvalModeAtPointer(schema, "/routes/0/returns/1")).toBe("runtime");
    expect(celEvalModeAtPointer(schema, "/routes/0/returns")).toBe("runtime");
  });

  it("reports nothing above the region, and outside it", () => {
    expect(celEvalModeAtPointer(schema, "/routes/0")).toBeNull();
    expect(celEvalModeAtPointer(schema, "")).toBeNull();
    expect(celEvalModeAtPointer(schema, "/name")).toBeNull();
  });

  it("does not follow a $ref, exactly as the analyzer does not", () => {
    // Whatever this answers is a claim about what `telo check` accepts, so it
    // has to answer the same way — and the analyzer's walk stops at a `$ref`.
    // Nothing is lost in practice: a shared fragment is expanded in place at
    // load, and a step body carries its `x-telo-fragment` stamp on the slot
    // rather than behind the reference.
    expect(celEvalModeAtPointer(schema, "/settings/region")).toBeNull();
  });

  it("keeps what it resolved when a segment leads nowhere", () => {
    // A schema transplanted by `x-telo-schema-from` is not in this document.
    expect(celEvalModeAtPointer(schema, "/routes/0/returns/1/absent/deeper")).toBe("runtime");
    expect(celEvalModeAtPointer(schema, "/absent/deeper")).toBeNull();
  });
});

// Shaped like `Run.Choice`: the context is anchored on the ARRAY, so each row's
// predicate is CEL-bearing by virtue of where it sits, not by its own
// annotation.
const choiceSchema = {
  type: "object",
  properties: {
    choices: {
      title: "Choices",
      type: "array",
      "x-telo-context": { type: "object", properties: { inputs: { type: "object" } } },
      items: {
        type: "object",
        properties: {
          when: { title: "When", type: "boolean" },
          value: { title: "Value", type: "string" },
        },
      },
    },
    enabled: { title: "Enabled", type: "boolean" },
  },
};

describe("a predicate inside a CEL region", () => {
  it("offers the value/tag picker, so an expression can be written", () => {
    render(
      <ResourceSchemaForm
        schema={choiceSchema}
        values={{ choices: [{ when: true, value: "a" }] }}
        onChange={() => undefined}
      />,
    );
    const pickers = screen.getAllByTitle("How this value is written");
    // One for the row's `when`, one for its `value` — everything in the region.
    expect(pickers.length).toBeGreaterThanOrEqual(2);
    expect(pickers[0].textContent).toContain("value");
  });

  it("is still in force one level down, where a pointer-scoped form starts", () => {
    // The panel renders the ROW, so the array carrying the annotation is not in
    // the rendered subtree at all. Replaying the walk is what keeps the field
    // meaning the same thing from either route in.
    render(
      <ResourceSchemaForm
        schema={choiceSchema.properties.choices.items}
        values={{ when: true, value: "a" }}
        onChange={() => undefined}
        rootCelEval={celEvalModeAtPointer(choiceSchema, "/choices/0")}
      />,
    );
    expect(screen.getAllByTitle("How this value is written").length).toBeGreaterThanOrEqual(2);
  });

  it("offers only the tags that can satisfy the slot", () => {
    // A predicate evaluates to a boolean, so `!cel` fits and `!literal` — which
    // always produces a string — cannot. Decided by the tag's declared produced
    // type against the slot, not by naming the field.
    const predicate = offeredValueTags({ type: "boolean" }, "runtime").map((t) => t.id);
    expect(predicate).toContain("cel");
    expect(predicate).not.toContain("literal");
    // A string slot still takes both.
    const text = offeredValueTags({ type: "string" }, "runtime").map((t) => t.id);
    expect(text).toEqual(expect.arrayContaining(["cel", "literal"]));
  });

  it("leaves an ordinary boolean flag outside any region as a plain checkbox", () => {
    render(
      <ResourceSchemaForm
        schema={{ type: "object", properties: { enabled: choiceSchema.properties.enabled } }}
        values={{ enabled: true }}
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByTitle("How this value is written")).toBeNull();
  });
});
