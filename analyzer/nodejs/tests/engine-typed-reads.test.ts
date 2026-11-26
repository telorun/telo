import { describe, expect, it } from "vitest";
import { buildCelEnvironment } from "@telorun/templating";
import type { CelType } from "@telorun/cel";
import { celSchemaResolver } from "../src/cel-schema-resolver.js";
import { holdsOptional } from "../src/cel-slot-origin.js";
import { schemaPlaceLookups } from "../src/schema-provenance.js";
import { assertReferencesReported, recordHandedSchema, unjudgedSchemaFindings } from "../src/schema-unjudged.js";
import { collectFilePositions } from "../src/diagnostic-location.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { parseAllDocuments } from "yaml";
import { BUILTIN_VOCABULARY_ARCHIVE } from "../src/builtin-vocabulary/index.js";
import { expandManifestFragments } from "../src/manifest-schemas.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * Every CEL read is typed by the engine to full depth: a member read, an
 * operand and a nullable read below a binding's first level are the engine's
 * verdicts, a forwarded value is fitted over the origins of its result, and a
 * schema node the engine cannot read is one warning where it is written.
 */

function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports() {
      return true;
    },
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

const APP = "kind: Telo.Application\nmetadata: { name: App }\n";

/** Each finding of the CEL verdicts and the slot fit, as `<code> <path>: <message>`. */
async function check(text: string, codes = /^(CEL_|FUNCTION_RETURN_MISMATCH|SCHEMA_TYPE_REF_UNRESOLVED)/): Promise<string[]> {
  const url = "/app/telo.yaml";
  const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { positions: collectFilePositions(graph) })
    .filter((d) => codes.test(String(d.code)))
    .map((d) => `${d.code} ${(d.data as { path?: string }).path}: ${d.message}`);
}

/** A templated kind whose `self.a.x` is `x`, read in a body step, the body's
 *  `inputs:` and a `resources:` entry's field. */
const bodyReads = (x: string) => `${APP}---
kind: Telo.Definition
metadata: { name: Wrap }
capability: Telo.Invocable
schema:
  type: object
  properties:
    a: { type: object, properties: { x: { type: ${x} } } }
invoke: !ref target
inputs: { count: !cel "self.a.x + 1" }
resources:
  - kind: Telo.Value
    metadata: { name: target }
    inputType: { type: object, properties: { count: { type: integer } } }
    value: !cel "self.a.x + 1"
  - kind: Telo.Sequence
    metadata: { name: steps }
    steps:
      - name: s
        value: !cel "self.a.x + 1"
`;

describe("a read below a binding's first level", () => {
  it("is typed in a body step, a body's inputs and a resources entry's field", async () => {
    const found = await check(bodyReads("string"));
    expect(found.filter((f) => f.startsWith("CEL_TYPE_ERROR"))).toHaveLength(3);
    expect(found.every((f) => f.includes('no "+" is declared over string, int'))).toBe(true);
    expect(await check(bodyReads("integer"))).toEqual([]);
  });

  it("types `inputs` from the input contract", async () => {
    const found = await check(`${APP}---
kind: Telo.Sequence
metadata: { name: order }
inputType:
  type: object
  properties: { order: { type: object, properties: { total: { type: string } } } }
steps:
  - name: doubled
    value: !cel "inputs.order.total * 2"
`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^CEL_TYPE_ERROR steps\[0\]\.value: .*string, int/);
  });

  it("types `self` as the declared view: a number a double, an integer an int", async () => {
    const scale = (n: string) => `${APP}---
kind: Telo.Definition
metadata: { name: Scale }
capability: Telo.Runnable
schema: { type: object, properties: { n: { type: ${n} } } }
run: !ref seq
resources:
  - kind: Telo.Sequence
    metadata: { name: seq }
    steps:
      - name: v
        value: !cel "self.n * 10"
`;
    const found = await check(scale("number"));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('no "*" is declared over double, int');
    expect(await check(scale("integer"))).toEqual([]);
  });

  it("refuses an undeclared member once, and an unguarded nullable read once", async () => {
    const found = await check(`${APP}---
kind: Telo.Definition
metadata: { name: Reader }
capability: Telo.Invocable
schema:
  type: object
  properties:
    a: { type: object, additionalProperties: false, properties: { x: { type: string } } }
    m: { type: [object, "null"], properties: { b: { type: string } } }
invoke: !ref read
resources:
  - kind: Telo.Value
    metadata: { name: read }
    value:
      undeclared: !cel "self.a.y"
      unguarded: !cel "self.m.b"
      guarded: !cel "self.m != null && self.m.b == 'x'"
`);
    expect(found).toEqual([
      "CEL_UNKNOWN_FIELD resources[0].value.undeclared: Telo.Definition/Reader: !cel: 'self.a.y' is not defined (available: x)",
      expect.stringMatching(/^CEL_NULLABLE_ACCESS resources\[0\]\.value\.unguarded: .*'self\.m' may be null/),
    ]);
  });

  it("types a step's result in its target's contract document, a local reference included", async () => {
    const found = await check(`${APP}---
kind: Telo.Value
metadata: { name: produce }
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [error]
    properties: { error: { $ref: "#/$defs/Failure" } }
    $defs:
      Failure:
        anyOf:
          - { type: object, required: [message], properties: { message: { type: string } } }
          - { type: "null" }
value: { error: !cel "null" }
---
kind: Telo.Sequence
metadata: { name: call }
steps:
  - name: x
    invoke: !ref produce
  - name: read
    value: !cel "steps.x.result.error.message"
`);
    expect(found).toEqual([expect.stringMatching(/^CEL_NULLABLE_ACCESS steps\[1\]\.value: .*'steps\.x\.result\.error' may be null/)]);
  });

  it("types a module call's result through a named shape it references", async () => {
    const found = await check(`${APP}---
kind: Telo.JsonSchema
metadata: { name: Money }
schema: { type: object, properties: { amount: { type: string } } }
---
kind: Telo.Function
metadata: { name: price }
params: [{ name: n, schema: { type: integer } }]
returns: { schema: { type: object, properties: { m: !ref Money } } }
body: !cel "{'m': {'amount': string(n)}}"
---
kind: Telo.Value
metadata: { name: priced }
value: !cel "Self.price(1).m.amount + 1"
`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^CEL_TYPE_ERROR value: .*string, int/);
  });

  it("types a language value type two levels deep in `variables`", async () => {
    const found = await check(`kind: Telo.Application
metadata: { name: App }
variables:
  cfg:
    env: CFG
    type: object
    default: {}
    properties: { blob: { x-telo-type: Telo.Bytes } }
---
kind: Telo.Value
metadata: { name: blob }
value: !cel "variables.cfg.blob + 1"
`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^CEL_TYPE_ERROR value: .*bytes, int/);
  });
});

/** A templated kind forwarding `inputs` to an entry whose input contract is `slots`. */
const forward = (own: string, inputs: string, slots: string) => `${APP}---
kind: Telo.Definition
metadata: { name: Forward }
capability: Telo.Invocable
schema: { type: object, properties: { ${own} } }
invoke: !ref target
inputs: { ${inputs} }
resources:
  - kind: Telo.Value
    metadata: { name: target }
    inputType: { type: object, properties: { ${slots} } }
    value: {}
`;

describe("a forwarded value's fit, over the origins of its result", () => {
  it("sees an optional in a record's undeclared members and a tuple's positions and rest", () => {
    const string: CelType = { kind: "primitive", name: "string" };
    const optional: CelType = { kind: "optional", value: string };
    const shapes: CelType[] = [
      { kind: "record", fields: new Map([["a", string]]), additionalFields: optional },
      { kind: "list", element: string, prefixElements: [string, optional] },
      { kind: "list", element: string, prefixElements: [string], additionalElements: optional },
    ];
    expect(shapes.map(holdsOptional)).toEqual([true, true, true]);
    expect(holdsOptional({ kind: "list", element: string, prefixElements: [string], additionalElements: string })).toBe(false);
  });

  it("refuses an optional at every slot, an untyped one included, naming .orValue", async () => {
    const found = await check(
      forward(
        "a: { type: string }",
        `t1: !cel "optional.of(self.a)", t2: !cel "self.?a", l: !cel "[self.?a]", ok: !cel "self.?a.orValue('x')"`,
        "t1: { type: string }, t2: { type: string }, l: { type: array }, ok: { type: string }",
      ),
    );
    expect(found.map((f) => f.split(":")[0])).toEqual([
      "CEL_TYPE_ERROR inputs.t1",
      "CEL_TYPE_ERROR inputs.t2",
      "CEL_TYPE_ERROR inputs.l",
    ]);
    expect(found.every((f) => f.includes("holds an optional") && f.includes(".orValue(<a default>)"))).toBe(true);
  });

  it("fits a `cel.bind` result by the node its answer is read from", async () => {
    const found = await check(
      forward(
        "b: { type: object, properties: { c: { type: integer } } }",
        `bound: !cel "cel.bind(n, self.b.c, n)"`,
        "bound: { type: string }",
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("CEL at 'inputs.bound' reads 'n', declared 'integer', but target's declared inputType expects 'string'.");
  });

  it("names the null branch of a computed value as a type mismatch", async () => {
    const found = await check(
      forward("flag: { type: boolean }", `o: !cel "self.flag ? {'a': 1} : null"`, "o: { type: object }"),
    );
    expect(found).toEqual([
      "CEL_TYPE_ERROR inputs.o: Telo.Definition/Forward: CEL at 'inputs.o' returns 'null' from 'null' but target's declared inputType expects 'object'.",
    ]);
  });

  it("refuses at the first failing origin, past one that fits", async () => {
    const found = await check(
      forward(
        "flag: { type: boolean }, s: { type: string, enum: [a] }, n: { type: string, enum: [b] }",
        `v: !cel "self.flag ? self.s : self.n"`,
        "v: { type: string, enum: [a] }",
      ),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("reads 'self.n', whose declared shape does not fit");
  });
});

describe("a schema node the type checker cannot read", () => {
  it("is one warning where it is written, however many sites read beneath it", async () => {
    const found = await check(`${APP}---
kind: Telo.Definition
metadata: { name: Tagged }
capability: Telo.Invocable
schema:
  type: object
  properties:
    labels:
      type: object
      unevaluatedProperties: { type: string }
invoke: !ref read
inputs: { a: !cel "self.labels.p" }
resources:
  - kind: Telo.Value
    metadata: { name: read }
    value:
      first: !cel "self.labels.q"
      second: !cel "self.labels.r"
`);
    expect(found).toEqual([
      "CEL_SCHEMA_UNJUDGED schema.properties.labels: Telo.Definition/Tagged: the CEL type checker does not read keyword 'unevaluatedProperties' at 'schema.properties.labels': a member no other keyword of the node declares is read as 'additionalProperties' says, refused where that is absent or false.",
    ]);
  });

  it("looks each reported node's provenance up once, and refuses a node without one", async () => {
    const before = schemaPlaceLookups();
    await check(`${APP}---
kind: Telo.Definition
metadata: { name: Tagged }
capability: Telo.Invocable
schema:
  type: object
  properties:
    labels: { type: object, unevaluatedProperties: { type: string } }
invoke: !ref read
resources:
  - kind: Telo.Value
    metadata: { name: read }
    value: { first: !cel "self.labels.q", second: !cel "self.labels.r" }
`);
    expect(schemaPlaceLookups() - before).toBe(1);
    const base = buildCelEnvironment();
    const env = base.clone({ resolveSchemaType: celSchemaResolver(base, undefined) });
    const unplaced = { type: "object", unevaluatedProperties: { type: "string" } };
    recordHandedSchema(env, "x", unplaced);
    env.registerVariable("x", { schema: unplaced });
    expect(() => unjudgedSchemaFindings([env], new Set(), [])).toThrow(/has no recorded provenance/);
  });

  it("leaves a reference to nothing to the reference finding", async () => {
    const found = await check(`${APP}---
kind: Telo.Definition
metadata: { name: Missing }
capability: Telo.Invocable
schema: { type: object, properties: { m: { $ref: "telo://Self/Absent" } } }
invoke: !ref read
resources:
  - kind: Telo.Value
    metadata: { name: read }
    value: !cel "self.m.x"
`);
    expect(found.map((f) => f.split(" ")[0])).toEqual(["SCHEMA_TYPE_REF_UNRESOLVED"]);
  });

  it("refuses a signature naming a declaration that holds no shape, and reports nothing beneath it", async () => {
    const found = await check(
      `${APP}---
kind: Telo.Value
metadata: { name: thing }
value: 1
---
kind: Telo.Function
metadata: { name: measure }
params: [{ name: x, schema: { type: integer } }]
returns: { schema: !ref thing }
body: !cel "x + 1"
---
kind: Telo.Value
metadata: { name: read }
value: !cel "Self.measure(1).total + 1"
`,
      /^(CEL_|REFERENCE_KIND_MISMATCH)/,
    );
    expect(found).toEqual([
      "REFERENCE_KIND_MISMATCH returns.schema: Telo.Function/measure: 'returns.schema' names 'thing', a Telo.Value, which is not a named shape, so it constrains nothing. Reference a `Telo.JsonSchema` or another named shape, or write the schema inline.",
    ]);
  });

  it.each([
    ["a declaration that holds no shape", "!ref thing", "1", "REFERENCE_KIND_MISMATCH params[0].schema"],
    ["a shape nothing declares", '{ $ref: "telo://Self/Missing" }', "1", "SCHEMA_TYPE_REF_UNRESOLVED params[0].schema.$ref"],
    [
      "a shape nothing declares beneath it",
      '{ type: object, properties: { m: { $ref: "telo://Self/Missing" } } }',
      "a.m.x",
      "SCHEMA_TYPE_REF_UNRESOLVED params[0].schema.properties.m.$ref",
    ],
  ])("reads a parameter whose schema names %s as `dyn`, leaving it to the reference finding", async (_what, schema, body, finding) => {
    const found = await check(
      `${APP}---
kind: Telo.Value
metadata: { name: thing }
value: 1
---
kind: Telo.Function
metadata: { name: measure }
params: [{ name: a, schema: ${schema} }]
returns: { schema: { type: integer } }
body: !cel "${body}"
---
kind: Telo.Value
metadata: { name: read }
value: !cel "Self.measure(1)"
`,
      /^(CEL_|SCHEMA_TYPE_REF_UNRESOLVED|REFERENCE_KIND_MISMATCH)/,
    );
    expect(found.map((f) => f.split(":")[0])).toEqual([finding]);
  });

  it.each([
    ['{ $ref: "telo://Self/Missing" }', "SCHEMA_TYPE_REF_UNRESOLVED inputType.schema.properties.m.$ref"],
    ["!ref thing", "REFERENCE_KIND_MISMATCH inputType.schema.properties.m"],
  ])("reports a reference %s beneath an inline contract shape at the place it is written, a read of it `dyn`", async (member, finding) => {
    const found = await check(
      `${APP}---
kind: Telo.Value
metadata: { name: thing }
value: 1
---
kind: Telo.Sequence
metadata: { name: job }
inputType: { kind: Telo.JsonSchema, schema: { type: object, properties: { m: ${member} } } }
steps:
  - name: a
    value: !cel "inputs.m + 1"
`,
      /^(CEL_|SCHEMA_TYPE_REF_UNRESOLVED|REFERENCE_KIND_MISMATCH)/,
    );
    expect(found.map((f) => f.split(":")[0])).toEqual([finding]);
  });

  it("types an Application variable from the named shape its `$ref` names, and leaves one naming nothing to the reference finding", async () => {
    const found = await check(`kind: Telo.Application
metadata: { name: App }
variables:
  cfg: { env: CFG, type: object, $ref: "telo://Self/Config", default: { dir: /srv } }
  lost: { env: LOST, type: object, $ref: "telo://Self/Absent", default: {} }
---
kind: Telo.JsonSchema
metadata: { name: Config }
schema: { type: object, properties: { dir: { type: string } } }
---
kind: Telo.Value
metadata: { name: read }
value: !cel "variables.cfg.dir + 1"
`);
    expect(found.map((f) => f.split(":")[0])).toEqual(["SCHEMA_TYPE_REF_UNRESOLVED variables.lost.$ref", "CEL_TYPE_ERROR value"]);
  });

  it("reads an Application variable through a named shape a choice varies, in each configuration's own environment", async () => {
    const found = await check(
      `kind: Telo.Application
metadata: { name: App }
variables:
  strict: { env: STRICT, type: boolean, default: false }
  cfg: { env: CFG, type: object, $ref: "telo://Self/Config", default: {} }
---
kind: Telo.JsonSchema
metadata: { name: Config }
schema:
  type: object
  properties:
    dir: !if { if: !cel "variables.strict", then: { type: string }, else: { type: integer } }
---
kind: Telo.Value
metadata: { name: whole }
value: !cel "variables.cfg"
---
kind: Telo.Value
metadata: { name: block }
value: !cel "variables"
---
kind: Telo.Value
metadata: { name: member }
value: !cel "variables.cfg.dir + 1"
`,
      /./,
    );
    expect(found).toEqual([
      "CEL_TYPE_ERROR value: Telo.Value/member: !cel: no \"+\" is declared over string, int (when variables.strict is true)",
    ]);
  });

  it("reports a `$ref` naming nothing in an Application variable, and anywhere it was canonicalized, over the configurations of a module writing a choice", async () => {
    const found = await check(`kind: Telo.Application
metadata: { name: App }
variables:
  flag: { env: FLAG, type: boolean, default: false }
  lost: { env: LOST, type: object, $ref: "telo://Self/Absent", default: {} }
---
kind: Telo.JsonSchema
metadata: { name: Config }
schema: { type: object, properties: { dir: { $ref: "telo://Self/Missing" } } }
--- !if
metadata: { name: shown }
if: !cel "variables.flag"
then: { kind: Telo.Value, value: !cel "variables.lost" }
else: { kind: Telo.Value, value: 2 }
`);
    expect(found.map((f) => f.split(":")[0])).toEqual([
      "SCHEMA_TYPE_REF_UNRESOLVED variables.lost.$ref",
      "SCHEMA_TYPE_REF_UNRESOLVED schema.properties.dir.$ref",
    ]);
  });

  it("raises an internal error for a reference no reference finding reports", () => {
    const manifest = { kind: "Telo.Definition", metadata: { name: "Kind", source: "/app/telo.yaml" } };
    const place = { manifest, keys: ["schema", "properties", "m"] };
    expect(() => assertReferencesReported([{ place, registration: "self" }], [])).toThrow(
      /internal: the reference at 'schema\.properties\.m' of Telo\.Definition\/Kind was left unresolved for 'self'/,
    );
  });

  it("is never one of the built-in vocabulary's", () => {
    // Every schema the archive carries, as the analyzer hands one to the
    // engine: each kind's schema, status and contracts, each need type's
    // fields and parameters, and every shared fragment.
    const [root, ...documents] = parseAllDocuments(BUILTIN_VOCABULARY_ARCHIVE).map((doc) => doc.toJS() as Record<string, any>);
    // Each document's fragments are expanded as the loader expands a module's,
    // each recursive one hoisted to the root of the schema holding it.
    const schemas: [string, Record<string, any>][] = [];
    const add = (where: string, holder: Record<string, any>, field: string) => {
      const expanded = structuredClone(holder);
      expandManifestFragments(expanded);
      const schema = expanded[field];
      if (schema && typeof schema === "object" && !Array.isArray(schema)) schemas.push([where, schema]);
    };
    for (const [name, fragment] of Object.entries(root!.$defs as Record<string, unknown>)) {
      add(`$defs/${name}`, { schema: { type: "object", properties: { value: fragment } } }, "schema");
    }
    for (const doc of documents) {
      const name = `${doc.kind}/${doc.metadata?.name}`;
      for (const field of ["schema", "status", "inputType", "outputType", "parameters"]) add(`${name}.${field}`, doc, field);
      if (doc.kind === "Telo.NeedType" && doc.fields) {
        add(`${name}.fields`, { schema: { type: "object", properties: doc.fields } }, "schema");
      }
    }
    expect(schemas.map(([where]) => where)).toEqual(expect.arrayContaining(["$defs/Step", "Telo.NeedType/DurableDirectory.fields"]));
    const base = buildCelEnvironment();
    const typed = base.clone({ resolveSchemaType: celSchemaResolver(base, undefined) });
    schemas.forEach(([, schema], index) => typed.registerVariable(`b${index}`, { schema }));
    expect(
      typed
        .schemaReports()
        .flatMap((report) =>
          report.unjudged.map((node) => `${schemas[Number(report.name.slice(1))]![0]} ${node.pointer} ${node.reason} ${node.keywords.join(",")}`),
        ),
    ).toEqual([]);
  });
});
