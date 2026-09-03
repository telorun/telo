import { describe, expect, it } from "vitest";
import { entrySchemaFor } from "./entry-schema";

/** The real shape of `Telo.Application.targets`: a union of a bare reference,
 *  the post-resolution `{kind, name}` form, a gated `ref:`, and an invoke step. */
const applicationSchema = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: {
        "x-telo-ref": { kind: ["Telo.Runnable", "Telo.Service"], use: "call" },
        anyOf: [
          { type: "string" },
          {
            type: "object",
            required: ["kind", "name"],
            properties: { kind: { type: "string" }, name: { type: "string" } },
          },
          {
            type: "object",
            required: ["ref"],
            properties: { ref: { type: "string" }, when: { type: "string" } },
          },
          {
            type: "object",
            required: ["invoke"],
            properties: {
              name: { type: "string" },
              invoke: { "x-telo-ref": { kind: "Telo.Executable", use: "call" } },
              inputs: { type: "object" },
              when: { type: "string" },
            },
          },
        ],
      },
    },
  },
};

/** An entry list: a plain object per entry, no union at all. */
const apiSchema = {
  type: "object",
  properties: {
    routes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          method: { type: "string" },
          handler: { "x-telo-ref": { kind: "Telo.Executable", use: "trigger.inbound" } },
        },
      },
    },
  },
};

/** A step grammar behind a reference, as the recursive fragment is localized. */
const sequenceSchema = {
  type: "object",
  $defs: {
    "telo:Step": {
      anyOf: [
        {
          type: "object",
          required: ["invoke"],
          properties: { name: { type: "string" }, invoke: { type: "string" } },
        },
        {
          type: "object",
          required: ["while"],
          properties: {
            while: { type: "string" },
            do: { type: "array", items: { $ref: "#/$defs/telo:Step" } },
          },
        },
      ],
    },
  },
  properties: {
    steps: { type: "array", items: { $ref: "#/$defs/telo:Step" } },
  },
};

describe("the schema of one entry", () => {
  it("picks the union branch the entry was WRITTEN as", () => {
    const schema = entrySchemaFor(applicationSchema, "targets", { invoke: "writeLine" });
    expect(Object.keys(schema?.properties as object)).toEqual([
      "name",
      "invoke",
      "inputs",
      "when",
    ]);
  });

  it("picks a different branch for a different spelling of the same site", () => {
    const schema = entrySchemaFor(applicationSchema, "targets", { ref: "migrate", when: "x" });
    expect(Object.keys(schema?.properties as object)).toEqual(["ref", "when"]);
  });

  it("gives nothing for an entry written as a bare reference", () => {
    // There is no configuration to show and no object body to edit — the panel
    // edits a pointer's object, so this row has to fall back to its host.
    expect(entrySchemaFor(applicationSchema, "targets", "migrate")).toBeUndefined();
  });

  it("gives nothing for an entry no branch fits, rather than the raw union", () => {
    // An empty entry: the form would render a union as no fields at all, which
    // reads as a resource with nothing in it.
    expect(entrySchemaFor(applicationSchema, "targets", {})).toBeUndefined();
  });

  it("types an entry-list item, which is no union at all", () => {
    const schema = entrySchemaFor(apiSchema, "routes", { path: "/x", method: "GET" });
    expect(Object.keys(schema?.properties as object)).toEqual(["path", "method", "handler"]);
  });

  it("follows a reference to the step grammar", () => {
    const schema = entrySchemaFor(sequenceSchema, "steps", { invoke: "say" });
    expect(Object.keys(schema?.properties as object)).toEqual(["name", "invoke"]);
  });

  it("descends INTO an element on the way to a nested body", () => {
    const schema = entrySchemaFor(sequenceSchema, "steps[0].do", { invoke: "say" });
    expect(Object.keys(schema?.properties as object)).toEqual(["name", "invoke"]);
  });

  it("gives nothing for a shape the form cannot render in full", () => {
    // A `while` carries its body as a nested step array, which reaches the
    // grammar by reference. The form resolves none, so it would draw a text box
    // where a list of statements belongs.
    expect(entrySchemaFor(sequenceSchema, "steps", { while: "x", do: [] })).toBeUndefined();
  });

  it("gives nothing when the kind declares no such array", () => {
    expect(entrySchemaFor(apiSchema, "mounts", {})).toBeUndefined();
    expect(entrySchemaFor(undefined, "routes", {})).toBeUndefined();
  });
});
