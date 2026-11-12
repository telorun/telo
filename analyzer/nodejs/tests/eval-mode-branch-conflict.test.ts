import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { evalModeBranchConflicts } from "../src/eval-paths.js";
import { conflictLocation } from "../src/eval-mode-branch-conflict.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

const kind = (content: Record<string, any>) => ({
  type: "object",
  properties: { content },
});

const brief = (schema: Record<string, any>, shapes?: (id: string) => Record<string, any> | undefined) =>
  evalModeBranchConflicts(schema, shapes).map((c) => ({
    path: c.path,
    keyword: c.keyword,
    branch: c.branch,
    other: c.other,
    place: c.place,
    mode: c.mode,
    otherMode: c.otherMode,
    shape: c.shape,
  }));

describe("a union giving one property two eval meanings", () => {
  it("is a conflict at the branch holding the site, naming the other and both modes", () => {
    const schema = kind({
      oneOf: [
        { type: "object", properties: { type: { const: "a" }, text: { "x-telo-eval": "accessor" } } },
        { type: "object", properties: { type: { const: "b" }, text: { type: "string" } } },
      ],
    });
    expect(brief(schema)).toEqual([
      { path: "content", keyword: "oneOf", branch: 0, other: 1, place: ".text", mode: "accessor", otherMode: undefined, shape: undefined },
    ]);
    expect(conflictLocation(evalModeBranchConflicts(schema)[0]!)).toEqual([
      "properties", "content", "oneOf", 0, "properties", "text",
    ]);
  });

  it("compares the sites beneath a property both branches declare", () => {
    const schema = kind({
      anyOf: [
        { properties: { style: { properties: { color: { "x-telo-eval": "compile" } } } } },
        { properties: { style: { properties: { color: { "x-telo-eval": "runtime" } } } } },
      ],
    });
    expect(brief(schema)).toMatchObject([{ branch: 1, other: 0, place: ".style.color", mode: "runtime", otherMode: "compile" }]);
  });

  it("is a conflict when a site at the union's own path is not in every branch", () => {
    const schema = kind({ anyOf: [{ type: "string", "x-telo-eval": "compile" }, { type: "object" }] });
    expect(brief(schema)).toMatchObject([{ branch: 0, other: 1, place: "", mode: "compile", otherMode: undefined }]);
  });

  it("names the named shape holding the union", () => {
    const node = { oneOf: [{ properties: { text: { "x-telo-eval": "accessor" } } }, { properties: { text: {} } }] };
    const schema = kind({ $ref: "telo:Ui/Node" });
    expect(brief(schema, (id) => (id === "telo:Ui/Node" ? node : undefined))).toMatchObject([
      { path: "content", branch: 0, place: ".text", shape: "telo:Ui/Node" },
    ]);
  });
});

describe("a union whose branches agree", () => {
  it("passes when every branch holding the property gives it the same mode, whatever its type", () => {
    const schema = kind({
      oneOf: [
        { properties: { type: { const: "value" }, value: { "x-telo-eval": "accessor" } } },
        { properties: { type: { const: "time" }, value: { "x-telo-eval": "accessor", type: "string" } } },
        { properties: { type: { const: "markdown" }, value: { "x-telo-eval": "accessor", type: "object" } } },
      ],
    });
    expect(brief(schema)).toEqual([]);
  });

  it("passes when only one branch declares the property", () => {
    const schema = kind({
      oneOf: [{ properties: { value: { "x-telo-eval": "accessor" } } }, { properties: { label: { type: "string" } } }],
    });
    expect(brief(schema)).toEqual([]);
  });

  it("does not judge an allOf, which is a conjunction", () => {
    const schema = kind({
      allOf: [{ properties: { text: { "x-telo-eval": "accessor" } } }, { properties: { text: { type: "string" } } }],
    });
    expect(brief(schema)).toEqual([]);
  });
});

describe("the kinds a module declares", () => {
  it("judges a need type's kind, whose fields are its schema", async () => {
    const text = `kind: Telo.Application
metadata: { name: App }
---
kind: Telo.NeedType
metadata: { name: Access }
fields:
  token:
    oneOf:
      - { type: object, properties: { text: { x-telo-eval: accessor } } }
      - { type: object, properties: { text: { type: string } } }
`;
    const source: ManifestSource = {
      supports: () => true,
      async read(url: string) {
        if (url !== "/app/telo.yaml") throw new Error(`File not found: ${url}`);
        return { text, source: url };
      },
      resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
    };
    const graph = await new Loader([source]).loadGraph("/app/telo.yaml", { desugarImports: true });
    const found = new StaticAnalyzer()
      .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
      .filter((d) => d.code === "EVAL_MODE_BRANCH_CONFLICT");
    expect(found.map((d) => d.message)).toEqual([
      expect.stringContaining("Telo.NeedType 'Access' declares a union at 'schema.properties.fields.properties.token'"),
    ]);
  });
});
