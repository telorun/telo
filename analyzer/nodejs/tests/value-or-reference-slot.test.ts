import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A slot unioning a closed value branch with a reference branch — a declared
 * column's `type:`, which holds either a storage class or a `!ref` to a declared
 * enum. What is under test is that the scalar is read as a VALUE rather than as
 * the removed string-reference spelling, while everything the reference-form
 * rule guards stays guarded.
 */

const app: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "TestApp", version: "1.0.0" },
} as unknown as ResourceManifest;

const enumDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Enum", module: "pg" },
  capability: "Telo.Provider",
  schema: {
    type: "object",
    properties: {
      typeName: { type: "string" },
      values: { type: "array", items: { type: "string" } },
    },
  },
} as unknown as ResourceManifest;

const tableDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Table", module: "pg" },
  capability: "Telo.Provider",
  schema: {
    type: "object",
    properties: {
      table: { type: "string" },
      columns: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            type: {
              oneOf: [
                { title: "Storage class", type: "string", enum: ["text", "uuid", "bigint"] },
                {
                  title: "Enum type",
                  type: "object",
                  "x-telo-ref": { kind: "pg.Enum", use: "schema" },
                },
              ],
            },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

const roleEnum: ResourceManifest = {
  kind: "pg.Enum",
  metadata: { name: "messageRole" },
  typeName: "message_role",
  values: ["system", "user", "assistant"],
} as unknown as ResourceManifest;

const table = (columnType: unknown): ResourceManifest =>
  ({
    kind: "pg.Table",
    metadata: { name: "messages" },
    table: "messages",
    columns: { role: { type: columnType } },
  }) as unknown as ResourceManifest;

const analyze = (...extra: ResourceManifest[]) =>
  new StaticAnalyzer().analyze(
    withSyntheticPositions([app, enumDef, tableDef, roleEnum, ...extra]),
  );

describe("a slot unioning a closed value branch with a reference branch", () => {
  it("accepts the scalar — it is a value, not a malformed reference", () => {
    const diags = analyze(table("text"));
    expect(diags.filter((d) => d.code === "INVALID_REFERENCE_FORM")).toEqual([]);
    expect(diags.filter((d) => d.code === "SCHEMA_VIOLATION")).toEqual([]);
  });

  it("resolves the `!ref` on the reference branch", () => {
    const diags = analyze(table(makeTaggedSentinel("ref", "messageRole")));
    expect(diags.filter((d) => d.code === "UNRESOLVED_REFERENCE")).toEqual([]);
    expect(diags.filter((d) => d.code === "INVALID_REFERENCE_FORM")).toEqual([]);
  });

  it("reports a `!ref` that names nothing", () => {
    const diags = analyze(table(makeTaggedSentinel("ref", "noSuchEnum")));
    expect(diags.find((d) => d.code === "UNRESOLVED_REFERENCE")).toBeDefined();
  });

  it("reports a misspelled storage class as an unknown value, and ONLY that", () => {
    const diags = analyze(table("txt"));
    const violation = diags.find((d) => d.code === "SCHEMA_VIOLATION");
    expect(violation).toBeDefined();
    expect(violation!.message).toContain("text");
    // Never "write it as '!ref txt'" — that instructs the author to convert a
    // typo'd storage class into a reference.
    expect(diags.filter((d) => d.code === "INVALID_REFERENCE_FORM")).toEqual([]);
  });

  it("accepts an OBJECT-shaped value branch rather than reading it as a reference", () => {
    const objectBranchDef: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Column", module: "pg" },
      capability: "Telo.Provider",
      schema: {
        type: "object",
        properties: {
          type: {
            anyOf: [
              {
                type: "object",
                properties: { of: { type: "string" } },
                required: ["of"],
                additionalProperties: false,
              },
              { type: "object", "x-telo-ref": { kind: "pg.Enum", use: "schema" } },
            ],
          },
        },
      },
    } as unknown as ResourceManifest;
    const column: ResourceManifest = {
      kind: "pg.Column",
      metadata: { name: "role" },
      type: { of: "text" },
    } as unknown as ResourceManifest;

    const diags = analyze(objectBranchDef, column);
    expect(diags.filter((d) => d.code === "INVALID_REFERENCE")).toEqual([]);
    expect(diags.filter((d) => d.code === "INVALID_REFERENCE_FORM")).toEqual([]);
  });
});

describe("what the reference-form rule still guards", () => {
  it("rejects a bare string at a slot whose reference constraint is the node's own", () => {
    const dispatcherDef: ResourceManifest = {
      kind: "Telo.Definition",
      metadata: { name: "Dispatcher", module: "pg" },
      capability: "Telo.Runnable",
      schema: { type: "object", properties: { handler: { "x-telo-ref": "pg.Enum" } } },
    } as unknown as ResourceManifest;
    const dispatcher: ResourceManifest = {
      kind: "pg.Dispatcher",
      metadata: { name: "main" },
      handler: "messageRole",
    } as unknown as ResourceManifest;

    const diags = analyze(dispatcherDef, dispatcher);
    expect(diags.find((d) => d.code === "INVALID_REFERENCE_FORM")).toBeDefined();
  });

  it("rejects the removed `{kind, name}` object at a union slot", () => {
    const diags = analyze(table({ kind: "pg.Enum", name: "messageRole" }));
    expect(diags.find((d) => d.code === "INVALID_REFERENCE_FORM")).toBeDefined();
  });
});
