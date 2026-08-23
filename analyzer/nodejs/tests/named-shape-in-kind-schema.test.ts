import { describe, expect, it } from "vitest";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { resolveRefIn, selectUnionBranch, substituteCelFields } from "../src/schema-compat.js";

/**
 * A kind whose `schema:` describes a slot with a shape declared elsewhere.
 *
 * Both halves used to go blind here, in opposite ways that hid each other: the
 * analyzer validated resource config on an AJV where named shapes were never
 * registered, so the schema failed to compile and the failure was swallowed —
 * `telo check` said nothing about a resource the kernel then rejected at boot.
 * And every walk that places a CEL stand-in stopped at the reference, so a
 * described value read as undescribed and its expressions were reported as
 * violations of a value nobody wrote.
 */
const NODE_ID = "telo:Test/Node";
const NODE = {
  anyOf: [{ $ref: "#/$defs/Text" }, { $ref: "#/$defs/Table" }],
  $defs: {
    Text: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: { text: { type: "string" }, style: { type: "string" } },
    },
    Table: {
      type: "object",
      required: ["table"],
      additionalProperties: false,
      properties: {
        table: {
          type: "object",
          required: ["body"],
          additionalProperties: false,
          properties: { body: { type: "array" } },
        },
      },
    },
  },
};

const KIND_SCHEMA = {
  type: "object",
  required: ["content"],
  additionalProperties: false,
  properties: { content: { type: "array", items: { $ref: NODE_ID } } },
};

function registry(): DefinitionRegistry {
  const defs = new DefinitionRegistry();
  expect(defs.registerNamedTypeSchema(NODE_ID, NODE)).toBe(true);
  return defs;
}

const cel = (source: string) => ({ __tagged: true, engine: "cel", source }) as unknown;

describe("a kind schema referencing a named shape", () => {
  it("validates the resource, rather than silently checking nothing", () => {
    const defs = registry();
    const issues = defs.validateResourceConfig({ content: [{ paragraph: "x" }] }, KIND_SCHEMA);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("matches no alternative");
    expect(issues[0].path).toBe("content[0]");
  });

  it("reports a fault inside the referenced shape at its own path", () => {
    const defs = registry();
    const issues = defs.validateResourceConfig(
      { content: [{ table: { body: "not-an-array" } }] },
      KIND_SCHEMA,
    );
    expect(issues.map((i) => [i.path, i.message])).toEqual([
      ["content[0].table.body", "/content/0/table/body must be array"],
    ]);
  });

  it("places a CEL stand-in typed by the shape, at any depth", () => {
    const defs = registry();
    const value = {
      content: [{ text: cel("inputs.title") }, { table: { body: cel("inputs.rows") } }],
    };
    const substituted = substituteCelFields(value, KIND_SCHEMA, undefined, {
      external: (ref) => defs.schemaForId(ref),
    }) as any;
    // Typed, not the `null` an unresolved node yields — and typed DIFFERENTLY
    // per slot, which is what proves the shape was actually read.
    expect(substituted.content[0].text).toBe("");
    expect(substituted.content[1].table.body).toEqual([]);
    expect(defs.validateResourceConfig(substituted, KIND_SCHEMA)).toEqual([]);
  });

  it("resolves a reference INSIDE the shape against that shape's own document", () => {
    // The branches are `#/$defs/…` relative to the shape, not to the schema that
    // referenced it. Resolving them against the referrer finds nothing, every
    // branch then reads as unconstrained, and the union resolves to nothing.
    const defs = registry();
    const target = resolveRefIn({ $ref: NODE_ID }, KIND_SCHEMA, (r) => defs.schemaForId(r));
    expect(target.root).toBe(target.schema);
    const branch = selectUnionBranch(
      target.schema,
      { table: { body: [] } },
      target.root,
      (r) => defs.schemaForId(r),
    );
    expect(branch.required).toEqual(["table"]);
  });
});
