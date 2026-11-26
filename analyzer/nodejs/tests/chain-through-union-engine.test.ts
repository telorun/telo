import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectFilePositions } from "../src/diagnostic-location.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A chain read past a union is typed by the engine in every alternative, as
 * `telo check` reports it: what each alternative that can hold the member
 * declares, joined.
 */

type Schema = Record<string, any>;

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

const SHAPES = `kind: Telo.JsonSchema
metadata: { name: Named }
schema: { type: object, properties: { a: { $ref: "#/$defs/Leaf" } }, $defs: { Leaf: { type: integer } } }
---
kind: Telo.JsonSchema
metadata: { name: Tree }
schema: { type: object, properties: { value: { type: string }, next: { anyOf: [{ $ref: "#" }, { type: "null" }] } } }
`;

/**
 * What `telo check` reports for `expression` read in a kind whose schema is
 * `schema`: the type of the value added to `true` (every operand type refuses
 * a boolean, so the refusal names it), and every other finding.
 */
async function read(schema: Schema, expression: string): Promise<{ type?: string; findings: string[] }> {
  const url = "/app/telo.yaml";
  const text = `kind: Telo.Application
metadata: { name: App }
---
${SHAPES}---
kind: Telo.Definition
metadata: { name: Reader }
capability: Telo.Invocable
schema: ${JSON.stringify(schema)}
invoke: !ref read
resources:
  - kind: Telo.Value
    metadata: { name: read }
    value: !cel ${JSON.stringify(expression)}
`;
  const graph = await new Loader([source({ [url]: text })]).loadGraph(url, { desugarImports: true });
  const found = new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { positions: collectFilePositions(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => `${d.code}: ${d.message}`);
  const operand = /no "\+" is declared over (.+?), bool(?:;|$)/;
  const added = found.find((f) => operand.test(f));
  return { type: added ? operand.exec(added)![1] : undefined, findings: found.filter((f) => f !== added) };
}

const text = { type: "string" };
const integer = { type: "integer" };
const holding = (properties: Schema, more: Schema = {}) => ({ type: "object", properties, ...more });
const union = (...alternatives: unknown[]) => ({ anyOf: alternatives });
const shaped = (shape: unknown, $defs?: Schema) => ({ type: "object", properties: { shape }, ...($defs ? { $defs } : {}) });

describe("a chain that continues past a union", () => {
  it("reads `oneOf` as it reads `anyOf`", async () => {
    expect(await read(shaped({ oneOf: [holding({ a: text }), holding({ a: integer })] }), "self.shape.a + true")).toEqual({
      type: "string|int",
      findings: [],
    });
  });

  it.each([
    ["a map's value beside a schema for additional members", { type: "object", additionalProperties: text }],
    ["the parts of an `allOf`", { allOf: [holding({ a: text })] }],
    ["a pattern-keyed member", holding({}, { additionalProperties: false, patternProperties: { "^a$": text } })],
    ["nothing from a branch admitting no value", false],
  ])("reads %s", async (said, alternative) => {
    expect(await read(shaped(union(holding({ a: text }), alternative)), "self.shape.a + true")).toEqual({
      type: "string",
      findings: [],
    });
  });

  it("claims nothing beside an untyped branch", async () => {
    expect(await read(shaped(union(holding({ a: text }), { required: ["a"] })), "self.shape.a + true")).toEqual({
      type: "dyn",
      findings: [],
    });
  });

  it("refuses an unguarded read through a `null` branch, and reads the others once guarded", async () => {
    const shape = shaped(union({ type: "null" }, holding({ a: text })));
    const { findings } = await read(shape, "self.shape.a + true");
    expect(findings).toEqual([expect.stringMatching(/^CEL_NULLABLE_ACCESS: .*'self\.shape' may be null/)]);
    expect(await read(shape, "self.shape != null ? self.shape.a + true : 1")).toEqual({ type: "string", findings: [] });
  });

  it.each([
    ["a constant", { const: "none" }, "string"],
    ["a value type over a scalar", { "x-telo-type": "Telo.TcpPort" }, "Telo.TcpPort"],
    ["an instance value type", { "x-telo-type": "Telo.Bytes" }, "bytes"],
  ])("refuses a member read where %s may stand", async (said, alternative, held) => {
    const { findings } = await read(shaped(union(alternative, holding({ a: text }))), "self.shape.a + true");
    expect(findings).toEqual([`CEL_TYPE_ERROR: Telo.Definition/Reader: !cel: ${held} holds no members`]);
  });

  it("distributes an alternative that is itself a union, and each union it crosses", async () => {
    const inner = union(holding({ b: text }), holding({ b: integer }));
    const shape = shaped(union(holding({ a: inner }), union(holding({ a: holding({ b: text }) }), { type: "null" })));
    expect(await read(shape, "self.shape != null ? self.shape.a.b + true : 1")).toEqual({ type: "string|int", findings: [] });
  });

  it("reads an index in every alternative", async () => {
    const rows = (items?: Schema) => ({ type: "array", ...(items ? { items } : {}) });
    expect(await read(shaped(union(rows(holding({ a: text })), { type: "null" })), "self.shape != null ? self.shape[0].a + true : 1")).toEqual({
      type: "string",
      findings: [],
    });
    expect(await read(shaped(union(rows(holding({ a: text })), rows())), "self.shape[0].a + true")).toEqual({
      type: "dyn",
      findings: [],
    });
  });

  it("meets a union's own properties with each alternative, an impossible meet holding no member", async () => {
    const shape = shaped({ ...holding({ a: text }), anyOf: [holding({ a: integer }), holding({ other: text })] });
    expect(await read(shape, "self.shape.a + true")).toEqual({
      type: "string",
      findings: [
        `CEL_UNKNOWN_FIELD: Telo.Definition/Reader: !cel: "a" is declared by only some of the shapes this value may have — read it as '.?a' to handle the others`,
      ],
    });
  });

  it("splices a tail that is a bare union, so the result is one level deep", async () => {
    const shape = shaped(
      union(holding({ a: { description: "either", anyOf: [text, { type: "null" }] } }), holding({ a: text }), holding({ a: integer })),
    );
    expect((await read(shape, "self.shape.a + true")).type).toBe("string|null|int");
  });

  it("terminates on a shape that contains itself, reading the re-entered reference as dyn", async () => {
    const tree = { type: "object", properties: { tree: { $ref: "telo://Self/Tree" } } };
    expect(await read(tree, "self.tree.value + true")).toEqual({ type: "string", findings: [] });
    expect(await read(tree, "self.tree.next.next.next.value + true")).toEqual({ type: "dyn", findings: [] });
  });
});

describe("an alternative behind a reference", () => {
  it("is read as the shape it names, each against its own document's root", async () => {
    const shape = shaped(union({ $ref: "#/$defs/Local" }, { $ref: "telo://Self/Named" }, { $ref: "#/$defs/Absent" }), {
      Local: holding({ a: { $ref: "#/$defs/Leaf" } }),
      Leaf: text,
      Absent: { type: "null" },
    });
    expect(await read(shape, "self.shape != null ? self.shape.a + true : 1")).toEqual({ type: "string|int", findings: [] });
  });

  it("claims nothing through a named shape nothing resolves, which its reference finding reports", async () => {
    const { type, findings } = await read(shaped(union(holding({ a: text }), { $ref: "telo://Self/Unknown" })), "self.shape.a + true");
    expect(type).toBe("dyn");
    expect(findings).toContainEqual(
      "SCHEMA_TYPE_REF_UNRESOLVED: Telo.Definition/Reader: schema $ref 'telo://Self/Unknown' resolves to module 'App', which declares no Telo.Type named 'Unknown'.",
    );
  });

  it("claims nothing through a union that refers back to itself in place", async () => {
    const shape = shaped(union(holding({ a: text }), { $ref: "#/$defs/Loop" }), {
      Loop: union({ $ref: "#/$defs/Loop" }, holding({ a: text })),
    });
    const { type, findings } = await read(shape, "self.shape.a + true");
    expect(type).toBe("dyn");
    expect(findings).toEqual([expect.stringMatching(/^SCHEMA_IN_PLACE_CYCLE: /)]);
  });
});
