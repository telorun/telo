import { parseExpression, serializeTree, type CelNode } from "@telorun/cel";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectFilePositions } from "../src/diagnostic-location.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { expandManifestFragments, MANIFEST_SCHEMA_URI } from "../src/manifest-schemas.js";
import { stepGuardsAt } from "../src/step-guards.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A step's guard reaches the CEL sites of the steps it guards as an assumption
 * the engine is handed, and a value with no schema node is fitted to its slot by
 * the engine's type, a union fitting where every member does.
 */

const source = (files: Record<string, string>): ManifestSource => ({
  supports: () => true,
  async read(url: string) {
    const text = files[url];
    if (text === undefined) throw new Error(`File not found: ${url}`);
    return { text, source: url };
  },
  resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
});

/** Every error `telo check` reports for `documents`, as `<code> <path>`. */
async function errors(documents: string, root = "kind: Telo.Application\nmetadata: { name: App }"): Promise<string[]> {
  const url = "/app/telo.yaml";
  const graph = await new Loader([source({ [url]: `${root}\n---\n${documents}` })]).loadGraph(url, {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { positions: collectFilePositions(graph) })
    .filter((d) => d.severity === 1)
    .map((d) => `${d.code} ${(d.data as { path?: string } | undefined)?.path ?? ""}`);
}

const LIBRARY = `kind: Telo.Library
metadata: { name: Lib }
variables:
  v: { type: [object, "null"], properties: { b: { type: string } }, required: [b] }`;

describe("a step guard as an assumption", () => {
  it("narrows the sites its then: holds, and not its else: or the step after it", async () => {
    const throwing = (code: string) => `{ name: fail${code}, throw: { code: ${code}, displayMessage: "No item {$item}.", data: { item: !cel "inputs.item" } } }`;
    expect(
      await errors(`kind: Telo.Sequence
metadata: { name: job }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [item], properties: { item: { type: [string, "null"] } } }
steps:
  - name: onItem
    if: !cel "inputs.item != null"
    then: [${throwing("ERR_A")}]
    else: [${throwing("ERR_B")}]
  - ${throwing("ERR_C")}
`),
    ).toEqual([
      "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED steps[0].else[0].throw.data.item",
      "MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED steps[1].throw.data.item",
    ]);
  });

  it("carries an if: that failed into a later elseif:", async () => {
    expect(
      await errors(`kind: Telo.Sequence
metadata: { name: job }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { x: { type: [object, "null"], properties: { a: { type: string } }, required: [a] } } }
steps:
  - name: choose
    if: !cel "inputs.x == null"
    then: [{ name: none, value: 0 }]
    elseif: [{ if: !cel "true", then: [{ name: some, value: !cel "inputs.x.a" }] }]
  - name: unguarded
    value: !cel "inputs.x.a"
`),
    ).toEqual(["CEL_NULLABLE_ACCESS steps[1].value"]);
  });

  it("proves a switch: case on a string subject, and refuses the read under default:", async () => {
    expect(
      await errors(`kind: Telo.Sequence
metadata: { name: job }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [u]
    properties:
      u:
        anyOf:
          - { type: object, additionalProperties: false, required: [k, p], properties: { k: { const: a }, p: { type: integer } } }
          - { type: object, additionalProperties: false, required: [k], properties: { k: { const: b } } }
steps:
  - name: choose
    switch: !cel "inputs.u.k"
    cases:
      a: [{ name: picked, value: !cel "inputs.u.p" }]
    default: [{ name: other, value: !cel "inputs.u.p" }]
`),
    ).toEqual(["CEL_UNKNOWN_FIELD steps[0].default[0].value"]);
  });

  it("drops a proof on a step the guarded do: writes again", async () => {
    expect(
      await errors(`kind: Telo.Sequence
metadata: { name: job }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { m: { type: [object, "null"], properties: { a: { type: string } }, required: [a] } } }
steps:
  - { name: n, value: !cel "inputs.m" }
  - name: again
    while: !cel "steps.n.result != null"
    do:
      - { name: n, value: !cel "inputs.m" }
      - { name: read, value: !cel "steps.n.result.a" }
`),
    ).toEqual(["CEL_NULLABLE_ACCESS steps[1].do[1].value"]);
  });

  it("never proves a resource's reading, which is republished between steps", async () => {
    expect(
      await errors(`kind: Telo.Definition
metadata: { name: Probe }
capability: Telo.Provider
controllers: ["pkg:telo/local/js?path=./probe.mjs#Probe"]
schema: { type: object }
status:
  type: object
  properties: { y: { type: [object, "null"], properties: { z: { type: string } }, required: [z] } }
---
kind: App.Probe
metadata: { name: x }
---
kind: Telo.Sequence
metadata: { name: job }
steps:
  - name: probe
    if: !cel "resources.x.status.y != null"
    then: [{ name: read, value: !cel "resources.x.status.y.z" }]
`),
    ).toEqual(["CEL_NULLABLE_ACCESS steps[0].then[0].value"]);
  });

  it("holds an invoke step's when: over its own inputs:", async () => {
    expect(
      await errors(`kind: Telo.Value
metadata: { name: echo }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [a], properties: { a: { type: string } } }
value: !cel "inputs.a"
---
kind: Telo.Sequence
metadata: { name: job }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { x: { type: [object, "null"], properties: { b: { type: string } }, required: [b] } } }
steps:
  - name: call
    when: !cel "inputs.x != null"
    invoke: !ref echo
    inputs: { a: !cel "inputs.x.b" }
`),
    ).toEqual([]);
  });

  it("does not reach an inline declaration a guarded step dispatches", async () => {
    expect(
      await errors(
        `kind: Telo.Sequence
metadata: { name: job }
steps:
  - name: probe
    if: !cel "variables.v != null"
    then:
      - { name: inline, invoke: { kind: Telo.Value, value: !cel "variables.v.b" } }
      - { name: own, value: !cel "variables.v != null && variables.v.b == 'x'" }
`,
        LIBRARY,
      ),
    ).toEqual(["CEL_NULLABLE_ACCESS steps[0].then[0].invoke.value"]);
  });

  it("keeps a proof over variables only within one expression, in a plain sequence and under a choice", async () => {
    const doc = `kind: Telo.Sequence
metadata: { name: job }
steps:
  - name: probe
    if: !cel "variables.v != null"
    then:
      - { name: read, value: !cel "variables.v.b" }
      - { name: together, value: !cel "variables.v != null && variables.v.b == 'x'" }
`;
    const expected = ["CEL_NULLABLE_ACCESS steps[0].then[0].value"];
    expect(await errors(doc, LIBRARY)).toEqual(expected);
    expect(await errors(doc + KEYED, LIBRARY)).toEqual(expected);
  });

  it("keeps a proof over a caught error only within one expression", async () => {
    const doc = `kind: Telo.Sequence
metadata: { name: job }
steps:
  - name: attempt
    try: [{ name: fail, throw: { code: ERR_X, message: boom } }]
    catch:
      - name: probe
        if: !cel "error.displayMessage != null"
        then: [{ name: read, value: !cel "error.displayMessage.text" }]
`;
    const plain = await errors(doc, LIBRARY);
    expect(plain).toEqual(["CEL_NULLABLE_ACCESS steps[0].catch[0].then[0].value"]);
    expect(await errors(doc + KEYED, LIBRARY)).toEqual(plain);
  });

  it("keeps a proof over inputs and steps, in a plain sequence and in a replayed body", async () => {
    const steps = `steps:
  - { name: n, value: !cel "inputs.item" }
  - name: probe
    if: !cel "inputs.item != null && steps.n.result != null"
    then:
      - { name: first, value: !cel "inputs.item.b" }
      - { name: second, value: !cel "steps.n.result.b" }
`;
    const inputType = `inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { item: { type: [object, "null"], properties: { b: { type: string } }, required: [b] } } }
`;
    const sequence = (name: string) => `kind: Telo.Sequence
metadata: { name: ${name} }
${inputType}${steps}`;
    const workflow = `kind: Telo.Definition
metadata: { name: Workflow }
capability: Telo.Invocable
controllers: ["pkg:telo/local/js?path=./flow.mjs#Flow"]
schema:
  type: object
  properties:
    inputType: { type: object }
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
      x-telo-provides-zone: { replayed: every step's outcome is recorded and replayed }
---
kind: Self.Workflow
metadata: { name: flow }
${inputType}${steps}`;
    const dispatching = `${workflow}
---
${sequence("inner")}
---
kind: Self.Workflow
metadata: { name: outer }
steps:
  - { name: run, invoke: !ref inner, inputs: { item: { b: x } } }
`;
    for (const doc of [sequence("job"), workflow, dispatching]) {
      expect(await errors(doc, LIBRARY)).toEqual([]);
      expect(await errors(doc + KEYED, LIBRARY)).toEqual([]);
    }
  });
});

/** A choice in the root, so the analysis runs keyed by configuration. */
const KEYED = `
---
kind: Telo.Value
metadata: { name: pick }
value: !if
  if: !cel "variables.v != null"
  then: 1
  else: 2
`;

describe("a union-typed value at a slot", () => {
  it("fits where every member fits, and is refused where one does not", async () => {
    const target = (name: string, items: string) => `kind: Telo.Value
metadata: { name: ${name} }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [xs], properties: { xs: { type: array, items: ${items} } } }
value: 0`;
    const records =
      "{ anyOf: [{ type: object, additionalProperties: false, properties: { a: { type: string } } }, { type: object, additionalProperties: false, properties: { b: { type: integer } } }] }";
    expect(
      await errors(`${target("integers", "{ type: integer }")}
---
${target("records", records)}
---
kind: Telo.Sequence
metadata: { name: job }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [ms], properties: { ms: { type: array, items: ${records} } } }
steps:
  - { name: toIntegers, invoke: !ref integers, inputs: { xs: !cel "[{'a': 'x'}] + inputs.ms" } }
  - { name: toRecords, invoke: !ref records, inputs: { xs: !cel "[{'a': 'x'}] + inputs.ms" } }
  - { name: mappedToIntegers, invoke: !ref integers, inputs: { xs: !cel "inputs.ms.map(m, m)" } }
  - { name: mappedToRecords, invoke: !ref records, inputs: { xs: !cel "inputs.ms.map(m, m)" } }
`),
    ).toEqual(["CEL_TYPE_ERROR steps[0].inputs.xs", "CEL_TYPE_ERROR steps[2].inputs.xs"]);
  });

  it("judges a map's entries by any member of its value type, which joins them", async () => {
    expect(
      await errors(`kind: Telo.Value
metadata: { name: record }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [entry]
    properties:
      entry:
        type: object
        additionalProperties: false
        required: [path, before]
        properties: { path: { type: string }, before: { type: [string, "null"] } }
value: 0
---
kind: Telo.Sequence
metadata: { name: job }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, properties: { before: { type: [string, "null"] } } }
steps:
  - { name: call, invoke: !ref record, inputs: { entry: !cel "{'path': 'a', 'before': inputs.before}" } }
  - { name: wrong, invoke: !ref record, inputs: { entry: !cel "{'path': 1, 'before': 2}" } }
`),
    ).toEqual(["CEL_TYPE_ERROR steps[1].inputs.entry"]);
  });

  it("reads a union slot's branches over the base they share", async () => {
    expect(
      await errors(`kind: Telo.Value
metadata: { name: shaped }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [x]
    properties: { x: { type: object, anyOf: [{ required: [a] }, { required: [b] }] } }
value: 0
---
kind: Telo.Sequence
metadata: { name: job }
steps:
  - { name: call, invoke: !ref shaped, inputs: { x: !cel "size('ab')" } }
`),
    ).toEqual(["CEL_TYPE_ERROR steps[0].inputs.x"]);
  });
});

describe("a switch: guard", () => {
  it("compares the whole subject, a conditional one included", () => {
    const cel = (source: string) => makeTaggedSentinel("cel", source);
    const schema = { type: "object", properties: { steps: { type: "array", items: { $ref: `${MANIFEST_SCHEMA_URI}#/$defs/Step` } } } };
    expandManifestFragments(schema);
    const manifest = {
      steps: [
        {
          name: "choose",
          switch: cel("c ? u.k : 'b'"),
          cases: { a: [{ name: "picked", value: cel("1") }] },
          default: [{ name: "other", value: cel("2") }],
        },
      ],
    };
    /** Each guard's condition as its operator over the subject it compares. */
    const compared = (path: string) =>
      stepGuardsAt(manifest, schema, path, new Set())!.guards.map(({ condition, holds }) => {
        const root = parseExpression(condition).root as Extract<CelNode, { kind: "binary" }>;
        return [root.kind, root.operator, serializeTree(root.left), holds];
      });
    expect(compared("steps[0].cases.a[0].value")).toEqual([["binary", "==", "c ? u.k : \"b\"", true]]);
    expect(compared("steps[0].default[0].value")).toEqual([["binary", "in", "c ? u.k : \"b\"", false]]);
  });
});
