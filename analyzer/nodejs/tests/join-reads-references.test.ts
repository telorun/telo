import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * The CEL value/slot join reads a `$ref` as the shape it names — a
 * document-local pointer against the root of the document that declares it, a
 * named shape through the registry — on the producer's side at every hop of
 * its chain and at its tail, and on the slot's side at its leaf and in its
 * union branches.
 * Stopping at the reference read a nullable or mistyped producer as undeclared,
 * which checked clean and failed at dispatch with `ERR_INPUT_INVALID`.
 */

function source(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
}

const KINDS = `kind: Telo.Application
metadata: { name: Refs, version: 0.1.0 }
---
kind: Telo.Definition
metadata: { name: Value }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    inputType: { type: object }
    outputType: { type: object }
    value: { x-telo-eval: runtime }
---
kind: Telo.Definition
metadata: { name: Sequence }
capability: Telo.Runnable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    inputType: { type: object }
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
---
kind: Telo.JsonSchema
metadata: { name: MaybeText }
schema: { type: [string, "null"] }
---
kind: Telo.JsonSchema
metadata: { name: Box }
schema:
  type: object
  properties:
    text: { $ref: "#/$defs/Inner" }
  $defs:
    Inner: { type: [string, "null"] }
`;

const indent = (text: string, by: number) =>
  text
    .trim()
    .split("\n")
    .map((line) => " ".repeat(by) + line)
    .join("\n");

/** One producer step `made`, then `call` passing `argument` as `arg`. */
function flow(produced: string, slot: string, argument: string, more = "") {
  return declared(
    produced,
    slot,
    `${more}---
kind: Self.Sequence
metadata: { name: main }
steps:
  - name: made
    invoke: !ref produce
${more ? "  - name: other\n    invoke: !ref produceOther\n" : ""}  - name: call
    invoke: !ref take
    inputs:
      arg: !cel "${argument}"
`,
  );
}

/** `produce` declaring `produced` and `take` declaring `slot`, then `rest`. */
async function declared(produced: string, slot: string, rest: string) {
  const manifest = `${KINDS}---
kind: Self.Value
metadata: { name: produce }
outputType:
  kind: Telo.JsonSchema
  schema:
${indent(produced, 4)}
value: {}
---
kind: Self.Value
metadata: { name: take }
inputType:
  kind: Telo.JsonSchema
  schema:
${indent(slot, 4)}
value: {}
${rest}`;
  const graph = await new Loader([source({ "/app/telo.yaml": manifest })]).loadGraph("/app/telo.yaml", {
    desugarImports: true,
  });
  const found = new StaticAnalyzer().analyze(flattenForAnalyzer(graph));
  return found.map((d) => `${d.code}: ${d.message}`);
}

const textSlot = `
type: object
properties:
  arg: { type: string }
`;
const mayBeNull = (chain: string) => `reads '${chain}', which may be null, but take's declared inputType expects 'string'`;

describe("a producer declared behind a reference", () => {
  it.each([
    [
      "a document-local reference at the tail",
      `
type: object
properties:
  out: { $ref: "#/$defs/Maybe" }
$defs:
  Maybe: { type: [string, "null"] }
`,
      "steps.made.result.out",
    ],
    [
      "a named shape at the tail",
      `
type: object
properties:
  out: !ref MaybeText
`,
      "steps.made.result.out",
    ],
    [
      "a document-local reference at a hop",
      `
type: object
properties:
  out: { $ref: "#/$defs/Holder" }
$defs:
  Holder:
    type: object
    properties:
      text: { type: [string, "null"] }
`,
      "steps.made.result.out.text",
    ],
    [
      "a named shape at a hop, whose member is a reference of its own document",
      `
type: object
properties:
  out: !ref Box
`,
      "steps.made.result.out.text",
    ],
  ])("is nullable through %s", async (where, produced, chain) => {
    const found = await flow(produced, textSlot, chain);
    expect(found).toHaveLength(1);
    expect(found[0]!.startsWith("CEL_TYPE_ERROR: ")).toBe(true);
    expect(found[0]).toContain(mayBeNull(chain));
  });

  it("is held to its declared type", async () => {
    const found = await flow(
      `
type: object
properties:
  out: { $ref: "#/$defs/Text" }
$defs:
  Text: { type: string }
`,
      `
type: object
properties:
  arg: { type: integer }
`,
      "steps.made.result.out",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.startsWith("CEL_TYPE_ERROR: ")).toBe(true);
    expect(found[0]).toContain("source is 'string', target expects 'integer'");
  });

  it("resolves in its own document, beside another producer declaring the same name", async () => {
    const produced = `
type: object
properties:
  out: { $ref: "#/$defs/Out" }
$defs:
  Out: { type: string }
`;
    const other = `---
kind: Self.Value
metadata: { name: produceOther }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      out: { $ref: "#/$defs/Out" }
    $defs:
      Out: { type: integer }
value: {}
`;
    expect(await flow(produced, textSlot, "steps.made.result.out", other)).toEqual([]);
    const found = await flow(produced, textSlot, "steps.other.result.out", other);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("source is 'integer', target expects 'string'");
  });
});

describe("a slot whose union branches are references", () => {
  const slot = `
type: object
properties:
  arg:
    anyOf:
      - { $ref: "#/$defs/Count" }
      - !ref MaybeText
$defs:
  Count: { type: integer }
`;
  const produced = `
type: object
properties:
  out: { type: boolean }
`;

  it("refuses an expression no branch accepts, and accepts one a branch does", async () => {
    const found = await flow(produced, slot, "true");
    expect(found).toEqual([
      "CEL_TYPE_ERROR: Self.Sequence/main: CEL at 'steps[1].inputs.arg' returns 'bool' " +
        "but take's declared inputType expects 'integer | string | null'.",
    ]);
    expect(await flow(produced, slot, "1")).toEqual([]);
    expect(await flow(produced, slot, "'text'")).toEqual([]);
  });
});

describe("a document-local pointer", () => {
  const integerSlot = `
type: object
properties:
  arg: { type: integer }
`;

  it("at a slot declared as its document's root holds an expression to that root", async () => {
    const slot = `
type: object
properties:
  arg: { $ref: "#" }
  count: { type: integer }
`;
    expect(await flow("type: object", slot, "'abc'")).toEqual([
      "CEL_TYPE_ERROR: Self.Sequence/main: CEL at 'steps[1].inputs.arg' returns 'string' " +
        "but take's declared inputType expects 'object'.",
    ]);
  });

  it("at an item of a named shape declared as that shape's root holds an expression to it", async () => {
    const slot = `
type: object
properties:
  arg: !ref Content
`;
    const rest = `---
kind: Telo.JsonSchema
metadata: { name: Content }
schema:
  anyOf:
    - type: string
    - type: object
      properties:
        stack: { type: array, items: { $ref: "#" } }
---
kind: Self.Sequence
metadata: { name: main }
steps:
  - name: call
    invoke: !ref take
    inputs:
      arg:
        stack:
          - !cel "1"
`;
    expect(await declared("type: object", slot, rest)).toEqual([
      "CEL_TYPE_ERROR: Self.Sequence/main: CEL at 'steps[0].inputs.arg.stack[0]' returns 'int' " +
        "but take's declared inputType expects 'string | object'.",
    ]);
  });

  it.each([
    [
      "the root's member, under an object that has a member of that name",
      `
type: object
properties:
  holder:
    type: object
    properties:
      out: { $ref: "#/properties/leaf" }
      leaf: { type: string }
  leaf: { type: integer }
`,
    ],
    [
      "the root's `$defs` entry, under an object declaring one of that name",
      `
type: object
properties:
  holder:
    type: object
    properties:
      out: { $ref: "#/$defs/Leaf" }
    $defs:
      Leaf: { type: string }
$defs:
  Leaf: { type: integer }
`,
    ],
  ])("on the producer's side names %s", async (what, produced) => {
    const chain = "steps.made.result.holder.out";
    expect(await flow(produced, integerSlot, chain)).toEqual([]);
    const found = await flow(produced, textSlot, chain);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("source is 'integer', target expects 'string'");
  });

  // Only a step's result is known to be a document of its own. Anywhere else a
  // pointer's document is not known, so it is not followed.
  it.each([
    [
      "the resource's own inputs",
      `
type: object
properties:
  out: { type: string }
`,
      `---
kind: Self.Sequence
metadata: { name: main }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      word: { $ref: "#/$defs/Maybe" }
    $defs:
      Maybe: { type: [string, "null"] }
steps:
  - name: call
    invoke: !ref take
    inputs:
      arg: !cel "inputs.word"
`,
    ],
    [
      "a step forwarding part of another's result",
      `
type: object
properties:
  out:
    type: object
    properties:
      text: { $ref: "#/$defs/Maybe" }
$defs:
  Maybe: { type: [string, "null"] }
`,
      `---
kind: Self.Sequence
metadata: { name: main }
steps:
  - name: made
    invoke: !ref produce
  - name: part
    value: !cel "steps.made.result.out"
  - name: call
    invoke: !ref take
    inputs:
      arg: !cel "steps.part.result.text"
`,
    ],
  ])("claims nothing when read through %s", async (where, produced, rest) => {
    expect(await declared(produced, textSlot, rest)).toEqual([]);
  });
});
