import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * `x-telo-context-element-from-item`: a binding typed as the element of the
 * collection a field of the PER-SCOPE ITEM names. Each `lists[]` entry names
 * its own `rows`, and the context on its `columns` types `row` from them.
 */

const cel = (source: string) => ({ __tagged: true, engine: "cel", source });

const outputModel = {
  type: "object",
  properties: {
    title: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, size: { type: "integer" } },
      },
    },
    report: { type: "object", additionalProperties: true },
  },
};

function gridDef(columnBindings: Record<string, unknown>): ResourceManifest {
  return {
    kind: "Telo.Definition",
    metadata: { name: "Grid", module: "probe" },
    capability: "Telo.Provider",
    schema: {
      type: "object",
      properties: {
        outputModel: { type: "object", additionalProperties: true },
        inputType: { type: "object", additionalProperties: true },
        lists: {
          type: "array",
          items: {
            type: "object",
            properties: {
              model: { type: "object", additionalProperties: true },
              rows: {
                "x-telo-eval": "accessor",
                "x-telo-context": { type: "object", properties: columnBindings },
              },
              columns: {
                type: "array",
                "x-telo-context": {
                  type: "object",
                  properties: {
                    ...columnBindings,
                    row: { "x-telo-context-element-from-item": "rows" },
                  },
                },
                items: {
                  type: "object",
                  properties: { value: { "x-telo-eval": "accessor" } },
                },
              },
            },
          },
        },
      },
    },
  } as unknown as ResourceManifest;
}

const resultFromRoot = gridDef({ result: { "x-telo-context-from-root": "outputModel" } });

function grid(
  lists: Array<{ rows?: unknown; values: string[]; model?: unknown }>,
  extra: Record<string, unknown> = {},
): ResourceManifest {
  return {
    kind: "probe.Grid",
    metadata: { name: "grid", module: "test" },
    outputModel,
    ...extra,
    lists: lists.map(({ rows, values, model }) => ({
      ...(rows === undefined ? {} : { rows }),
      ...(model === undefined ? {} : { model }),
      columns: values.map((value) => ({ value: cel(value) })),
    })),
  } as unknown as ResourceManifest;
}

function check(def: ResourceManifest, resource: ResourceManifest) {
  return new StaticAnalyzer().analyze(withSyntheticPositions([def, resource]));
}

const unknownFields = (diagnostics: { code: string; message: string }[]) =>
  diagnostics.filter((d) => d.code === "CEL_UNKNOWN_FIELD").map((d) => d.message);

describe("x-telo-context-element-from-item", () => {
  it("types the binding as the element of the collection the item's field names", () => {
    const unknown = unknownFields(
      check(resultFromRoot, grid([{ rows: cel("result.files"), values: ["row.path", "row.pth"] }])),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("row.pth");
    expect(unknown[0]).toContain("path");
    expect(unknown[0]).toContain("size");
  });

  it("reads each item's own field, not the first item's", () => {
    const def = gridDef({
      result: { "x-telo-context-from-root": "outputModel" },
      extra: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "object", properties: { label: { type: "string" } } } },
        },
      },
    });
    const unknown = unknownFields(
      check(
        def,
        grid([
          { rows: cel("result.files"), values: ["row.path"] },
          { rows: cel("extra.tags"), values: ["row.label", "row.path"] },
        ]),
      ),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("row.path");
    expect(unknown[0]).toContain("label");
  });

  it("types from a sibling binding the per-scope annotation resolves", () => {
    const def = gridDef({ entry: { "x-telo-context-from": "model" } });
    const unknown = unknownFields(
      check(
        def,
        grid([
          {
            model: {
              lines: { type: "array", items: { type: "object", properties: { text: { type: "string" } } } },
            },
            rows: cel("entry.lines"),
            values: ["row.text", "row.txt"],
          },
        ]),
      ),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("row.txt");
  });

  it("types a chain rooted at `inputs` from the declared contract", () => {
    const unknown = unknownFields(
      check(
        gridDef({ inputs: {} }),
        grid([{ rows: cel("inputs.files"), values: ["row.path", "row.pth"] }], {
          inputType: outputModel,
        }),
      ),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("row.pth");
  });

  it.each([
    ["a chain landing on a non-collection", cel("result.title")],
    ["a chain through an open object", cel("result.report.entries")],
    ["a chain naming no binding", cel("nowhere.files")],
    ["an expression that is not a plain chain", cel("result.files.filter(f, f.size > 0)")],
    ["a literal", [{ path: "a" }]],
    ["an absent field", undefined],
  ])("leaves the binding untyped for %s", (label, rows) => {
    const diagnostics = check(resultFromRoot, grid([{ rows, values: ["row.anything"] }]));
    expect(diagnostics.filter((d) => d.message.includes("row.anything"))).toEqual([]);
  });

  it("leaves the binding untyped when the root binding is untyped", () => {
    const diagnostics = check(
      resultFromRoot,
      {
        ...grid([{ rows: cel("result.files"), values: ["row.anything"] }]),
        outputModel: undefined,
      } as unknown as ResourceManifest,
    );
    expect(diagnostics.filter((d) => d.message.includes("row.anything"))).toEqual([]);
  });

  it("follows the chain through a named shape", () => {
    const report = {
      kind: "Telo.JsonSchema",
      metadata: { name: "Report", module: "test" },
      schema: {
        type: "object",
        properties: {
          entries: { type: "array", items: { type: "object", properties: { line: { type: "integer" } } } },
        },
      },
    } as unknown as ResourceManifest;
    const resource = {
      ...grid([{ rows: cel("result.report.entries"), values: ["row.line", "row.lime"] }]),
      outputModel: { type: "object", properties: { report: { $ref: "telo:test/Report" } } },
    } as unknown as ResourceManifest;
    const unknown = unknownFields(
      new StaticAnalyzer().analyze(withSyntheticPositions([resultFromRoot, report, resource])),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("row.lime");
  });

  it("reads the body entry's own item inside a template body", () => {
    const wrapper = {
      kind: "Telo.Definition",
      metadata: { name: "Wrapper", module: "test" },
      capability: "Telo.Provider",
      schema: { type: "object", properties: { title: { type: "string" } } },
      resources: [
        {
          kind: "probe.Grid",
          metadata: { name: "grid" },
          outputModel,
          lists: [
            { rows: cel("result.files"), columns: [{ value: cel("row.path") }, { value: cel("row.pth") }] },
          ],
        },
      ],
      provide: { __tagged: true, engine: "ref", source: "grid" },
    } as unknown as ResourceManifest;
    const unknown = unknownFields(check(resultFromRoot, wrapper));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("row.pth");
    expect(unknown[0]).toContain("size");
  });
});
