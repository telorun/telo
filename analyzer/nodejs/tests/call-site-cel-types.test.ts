import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { expandManifestFragments, MANIFEST_SCHEMA_URI } from "../src/manifest-schemas.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A `!cel` argument at a call site is held to the target's declared inputType
 * by its CEL type — and, when it is a plain chain, by its producer's schema —
 * exactly as a resource's own field is. AJV sees the expression only as its
 * stand-in, so before this a string passed where the target declares an integer
 * checked clean and failed at dispatch with `ERR_INPUT_INVALID`.
 *
 * One kind per shape a call site takes: a step, a boot target's inline step, and
 * a reference slot naming its argument map, in the three forms the standard
 * library writes it (a route's handler, a top-level `invoke:`, a `handler:`).
 */

const cel = (source: string) => makeTaggedSentinel("cel", source);
const ref = (name: string) => makeTaggedSentinel("ref", name);

function definition(name: string, capability: string, schema: Record<string, any>) {
  const doc = { kind: "Telo.Definition", metadata: { name, module: "srv" }, capability, schema };
  expandManifestFragments(doc);
  return doc;
}

const callSlot = (use: string) => ({ "x-telo-ref": { kind: "Telo.Executable", use, inputs: "/inputs" } });
const argumentMap = (context: Record<string, any>) => ({
  type: "object",
  additionalProperties: true,
  "x-telo-context": { type: "object", properties: context },
});

const DEFINITIONS = [
  definition("Value", "Telo.Invocable", {
    type: "object",
    properties: {
      inputType: { type: "object" },
      outputType: { type: "object" },
      value: { "x-telo-eval": "runtime" },
      label: { type: "object", "x-telo-eval": "compile" },
    },
  }),
  definition("Sequence", "Telo.Runnable", {
    type: "object",
    properties: {
      steps: { type: "array", items: { $ref: `${MANIFEST_SCHEMA_URI}#/$defs/Step` } },
    },
  }),
  definition("Api", "Telo.Mount", {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            handler: callSlot("trigger.inbound"),
            inputs: argumentMap({
              request: {
                type: "object",
                properties: { path: { type: "string" }, headers: { type: "object" } },
              },
            }),
          },
        },
      },
    },
  }),
  definition("Tap", "Telo.Invocable", {
    type: "object",
    properties: { invoke: callSlot("trigger.consumer"), inputs: argumentMap({ item: {} }) },
  }),
  definition("Interval", "Telo.Service", {
    type: "object",
    properties: { invoke: callSlot("trigger.inbound"), inputs: argumentMap({}) },
  }),
  definition("EndHandler", "Telo.Invocable", {
    type: "object",
    properties: {
      handler: callSlot("trigger.consumer"),
      inputs: argumentMap({ records: { type: "array" } }),
    },
  }),
];

const jsonSchema = (schema: Record<string, any>) => ({ kind: "Telo.JsonSchema", schema });

/** The target every site calls: `count` an integer, `label` a string. */
const consume = {
  kind: "srv.Value",
  metadata: { name: "consume" },
  inputType: jsonSchema({
    type: "object",
    additionalProperties: false,
    properties: { count: { type: "integer" }, label: { type: "string" } },
  }),
  value: { ok: true },
};

function diagnose(
  resources: Record<string, any>[],
  app: Record<string, any> = {},
  definitions: Record<string, any>[] = [],
) {
  const manifests = [
    { kind: "Telo.Application", metadata: { name: "App", source: "telo.yaml" }, ...app },
    ...DEFINITIONS,
    ...definitions,
    ...resources.map((r) => ({ ...r, metadata: { ...r.metadata, source: "telo.yaml" } })),
  ] as unknown as ResourceManifest[];
  return new StaticAnalyzer().analyze(withSyntheticPositions(manifests));
}

function analyze(resources: Record<string, any>[], app: Record<string, any> = {}) {
  return diagnose(resources, app)
    .filter((d) => d.code === "CEL_TYPE_ERROR")
    .map((d) => `${(d.data as { path?: string }).path}: ${d.message}`);
}

const sequence = (steps: unknown[]) => ({ kind: "srv.Sequence", metadata: { name: "main" }, steps });

describe("a `!cel` argument's type against the target's inputType", () => {
  it("is refused at a step", () => {
    const [count, label, ...rest] = analyze([
      consume,
      sequence([
        {
          name: "call",
          invoke: ref("consume"),
          inputs: { count: cel("'abc'"), label: cel("{'a': 1}") },
        },
      ]),
    ]);
    expect(count).toBe(
      "steps[0].inputs.count: srv.Sequence/main: CEL at 'steps[0].inputs.count' returns 'string' " +
        "but consume's declared inputType expects 'integer'.",
    );
    expect(label).toContain("returns 'map<string, int>' but consume's declared inputType expects 'string'");
    expect(rest).toEqual([]);
  });

  it("is refused at a boot target's inline step, once, reading `variables`", () => {
    const found = analyze([consume], {
      variables: { name: { env: "NAME", type: "string" } },
      targets: [{ name: "call", invoke: ref("consume"), inputs: { count: cel("variables.name") } }],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("targets[0].inputs.count");
    expect(found[0]).toContain("'string' but consume's declared inputType expects 'integer'");
  });

  it("is refused at a route, reading `request` as the route declares it", () => {
    const found = analyze([
      consume,
      {
        kind: "srv.Api",
        metadata: { name: "api" },
        routes: [{ handler: ref("consume"), inputs: { count: cel("request.path") } }],
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("routes[0].inputs.count");
    expect(found[0]).toContain("reads 'request.path'");
    expect(found[0]).toContain("source is 'string', target expects 'integer'");
  });

  it.each([
    ["a tap", { kind: "srv.Tap", invoke: ref("consume") }],
    ["a schedule", { kind: "srv.Interval", invoke: ref("consume") }],
    ["an end handler", { kind: "srv.EndHandler", handler: ref("consume") }],
  ])("is refused at %s", (siteName, site) => {
    const found = analyze([
      consume,
      { ...site, metadata: { name: "site" }, inputs: { count: cel("'abc'") } },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("inputs.count");
    expect(found[0]).toContain("consume's declared inputType expects 'integer'");
  });

  it("refuses a value of another CEL type, and accepts one that fits", () => {
    const call = (count: string, label: string) =>
      analyze([
        consume,
        sequence([
          { name: "call", invoke: ref("consume"), inputs: { count: cel(count), label: cel(label) } },
        ]),
      ]);
    expect(call("1", "duration('50ms')")).toHaveLength(1);
    expect(call("1", "'50ms'")).toEqual([]);
  });

  it("reaches a leaf nested in a literal, and a map written as one expression", () => {
    const nested = {
      kind: "srv.Value",
      metadata: { name: "nested" },
      inputType: jsonSchema({
        type: "object",
        properties: { rows: { type: "array", items: { type: "object", properties: { n: { type: "integer" } } } } },
      }),
      value: {},
    };
    const call = (inputs: unknown) =>
      analyze([nested, sequence([{ name: "call", invoke: ref("nested"), inputs }])]);
    expect(call({ rows: [{ n: cel("'abc'") }] })[0]).toContain("steps[0].inputs.rows[0].n");
    expect(call(cel("'abc'"))[0]).toContain("CEL at 'steps[0].inputs' returns 'string'");
  });

  it("judges a chain declared a string by its producer's schema", () => {
    const produce = {
      kind: "srv.Value",
      metadata: { name: "produce" },
      outputType: jsonSchema({ type: "object", properties: { text: { type: "string" } } }),
      value: { text: "x" },
    };
    const found = analyze([
      consume,
      produce,
      sequence([
        { name: "made", invoke: ref("produce") },
        { name: "call", invoke: ref("consume"), inputs: { count: cel("steps.made.result.text") } },
      ]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("steps[1].inputs.count");
  });

  it("says nothing about a chain into a result its producer does not declare", () => {
    const undeclared = { kind: "srv.Value", metadata: { name: "undeclared" }, value: 1 };
    expect(
      analyze([
        consume,
        undeclared,
        sequence([
          { name: "made", invoke: ref("undeclared") },
          { name: "call", invoke: ref("consume"), inputs: { count: cel("steps.made.result") } },
        ]),
      ]),
    ).toEqual([]);
  });
});

describe("a nullable source into a slot that takes no null", () => {
  const objectSlot = { type: "object", properties: { message: { type: "string" } } };
  const failure = { type: "object", properties: { message: { type: "string" } } };
  const NULLABLE: Record<string, Record<string, any>> = {
    "a null union branch": { anyOf: [failure, { type: "null" }] },
    "a type list holding null": { ...failure, type: ["object", "null"] },
    "`nullable: true`": { ...failure, nullable: true },
    "an enum holding null": { enum: [null, "x"] },
    "a `type: null`": { type: "null" },
    "a null `const`": { const: null },
  };

  const flow = (produced: Record<string, any>, slot: Record<string, any>, expression: string) =>
    analyze([
      {
        kind: "srv.Value",
        metadata: { name: "produce" },
        outputType: jsonSchema({ type: "object", properties: { error: produced } }),
        value: {},
      },
      {
        kind: "srv.Value",
        metadata: { name: "release" },
        inputType: jsonSchema({ type: "object", properties: { failure: slot } }),
        value: {},
      },
      sequence([
        { name: "made", invoke: ref("produce") },
        { name: "call", invoke: ref("release"), inputs: { failure: cel(expression) } },
      ]),
    ]);
  const chain = "steps.made.result.error";

  it.each(Object.entries(NULLABLE))("refuses %s, naming the source and the guard", (form, produced) => {
    const found = flow(produced, objectSlot, chain);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`reads '${chain}', which may be null`);
    expect(found[0]).toContain(`${chain} != null ? ${chain} :`);
  });

  it("accepts it at an open slot and at one admitting null", () => {
    expect(flow(NULLABLE["a null union branch"]!, {}, chain)).toEqual([]);
    expect(flow(NULLABLE["a null union branch"]!, { type: ["object", "null"] }, chain)).toEqual([]);
  });

  it("accepts a guarded expression and a `dyn` one", () => {
    expect(
      flow(NULLABLE["a null union branch"]!, objectSlot, `${chain} != null ? ${chain} : {'message': ''}`),
    ).toEqual([]);
    expect(flow(NULLABLE["a null union branch"]!, objectSlot, `dyn(${chain})`)).toEqual([]);
  });

  it("refuses the same source at a resource's own field", () => {
    const found = analyze(
      [{ kind: "srv.Value", metadata: { name: "own" }, label: cel("variables.label") }],
      { variables: { label: { env: "LABEL", type: ["object", "null"] } } },
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("reads 'variables.label', which may be null, but the field expects 'object'");
  });
});

const stream = (of: unknown) => ({ "x-telo-type": { name: "Telo.Stream", of } });
const holding = (members: Record<string, any>) => ({
  type: "object",
  required: Object.keys(members),
  properties: members,
});

/** What is reported for `produced` flowing into `slot` through a plain chain. */
const atCallSite = (produced: Record<string, any>, slot: Record<string, any>) =>
  diagnose([
    {
      kind: "srv.Value",
      metadata: { name: "produce" },
      outputType: jsonSchema({ type: "object", properties: { out: produced } }),
      value: {},
    },
    {
      kind: "srv.Value",
      metadata: { name: "take" },
      inputType: jsonSchema({ type: "object", properties: { arg: slot } }),
      value: {},
    },
    sequence([
      { name: "made", invoke: ref("produce") },
      { name: "call", invoke: ref("take"), inputs: { arg: cel("steps.made.result.out") } },
    ]),
  ]);
const atOwnField = (produced: Record<string, any>, slot: Record<string, any>) =>
  diagnose(
    [{ kind: "srv.Hold", metadata: { name: "own" }, held: cel("src") }],
    {},
    [
      definition("Hold", "Telo.Invocable", {
        type: "object",
        properties: {
          held: {
            ...slot,
            "x-telo-context": { type: "object", properties: { src: produced } },
          },
        },
      }),
    ],
  );
const SITES = { "a call site": atCallSite, "an own field": atOwnField };
const judged = (found: ReturnType<typeof diagnose>) =>
  found
    .filter((d) => d.code === "CEL_TYPE_ERROR" || d.code === "CEL_TYPE_ARGUMENT_MISMATCH")
    .map((d) => `${d.code}: ${d.message}`);

describe("the code a plain chain's producer-schema conflict carries", () => {
  const bytes = { "x-telo-type": "Telo.Bytes" };
  const text = { type: "string" };

  const CASES: [string, Record<string, any>, Record<string, any>, string][] = [
    ["a type argument of one value type", stream("Telo.Bytes"), stream(text), "CEL_TYPE_ARGUMENT_MISMATCH"],
    [
      "a member's type argument",
      holding({ body: stream("Telo.Bytes") }),
      holding({ body: stream(text) }),
      "CEL_TYPE_ARGUMENT_MISMATCH",
    ],
    ["two value types", bytes, stream(text), "CEL_TYPE_ERROR"],
    ["a member of another value type", holding({ body: bytes }), holding({ body: stream(text) }), "CEL_TYPE_ERROR"],
    ["bytes into a JSON object", bytes, { type: "object" }, "CEL_TYPE_ERROR"],
    ["a JSON object into bytes", { type: "object" }, bytes, "CEL_TYPE_ERROR"],
    [
      "a missing required member",
      { type: "object", properties: { a: text } },
      holding({ b: text }),
      "CEL_TYPE_ERROR",
    ],
  ];

  describe.each(Object.entries(SITES))("at %s", (siteName, site) => {
    it.each(CASES)("%s", (conflict, produced, slot, code) => {
      const found = judged(site(produced, slot));
      expect(found).toHaveLength(1);
      expect(found[0]!.startsWith(`${code}: `)).toBe(true);
    });

    it("an argument conflict beside a shape conflict is one type error listing both", () => {
      const found = judged(
        site(
          { type: "object", properties: { body: stream("Telo.Bytes") } },
          holding({ body: stream(text), b: text }),
        ),
      );
      expect(found).toHaveLength(1);
      expect(found[0]!.startsWith("CEL_TYPE_ERROR: ")).toBe(true);
      expect(found[0]).toContain("/body<of>");
      expect(found[0]).toContain("/b: required by");
    });
  });
});

describe("JSON types compared by containment", () => {
  const integer = { type: "integer" };
  const number = { type: "number" };
  const port = { "x-telo-type": "Telo.TcpPort" };
  const list = (items: Record<string, any>) => ({ type: "array", items });

  const CLEAN: [string, Record<string, any>, Record<string, any>][] = [
    ["an integer into a number", integer, number],
    ["a port into a number", port, number],
    ["an integer member into a number member", holding({ n: integer }), holding({ n: number })],
    ["integer items into number items", list(integer), list(number)],
    ["a stream of integers into a stream of numbers", stream(integer), stream(number)],
  ];
  const REFUSED: [string, Record<string, any>, Record<string, any>, string][] = [
    ["a number into an integer", number, integer, "CEL_TYPE_ERROR"],
    ["a number into a port", number, port, "CEL_TYPE_ERROR"],
    ["a number member into an integer member", holding({ n: number }), holding({ n: integer }), "CEL_TYPE_ERROR"],
    ["number items into integer items", list(number), list(integer), "CEL_TYPE_ERROR"],
    [
      "a stream of numbers into a stream of integers",
      stream(number),
      stream(integer),
      "CEL_TYPE_ARGUMENT_MISMATCH",
    ],
  ];

  describe.each(Object.entries(SITES))("at %s", (siteName, site) => {
    it.each(CLEAN)("accepts %s", (pair, produced, slot) => {
      expect(judged(site(produced, slot))).toEqual([]);
    });

    it.each(REFUSED)("refuses %s", (pair, produced, slot, code) => {
      const found = judged(site(produced, slot));
      expect(found).toHaveLength(1);
      expect(found[0]!.startsWith(`${code}: `)).toBe(true);
    });
  });
});

describe("a template definition's top-level `inputs:`", () => {
  /** A kind dispatching to `target`, whose `count` is an integer. */
  const wrap = (inputs: unknown, own: Record<string, any> = {}) =>
    analyze([
      {
        kind: "Telo.Definition",
        metadata: { name: "Wrap", module: "srv" },
        capability: "Telo.Invocable",
        schema: { type: "object" },
        ...own,
        invoke: ref("target"),
        inputs,
        resources: [{ ...consume, metadata: { name: "target" } }],
      },
    ]);
  const maybe = { type: "object", properties: { limit: { type: ["integer", "null"] } } };

  it("is refused for an expression of another type, naming the target's inputType", () => {
    expect(wrap({ count: cel("'abc'") })).toEqual([
      "inputs.count: Telo.Definition/Wrap: CEL at 'inputs.count' returns 'string' " +
        "but target's declared inputType expects 'integer'.",
    ]);
  });

  it.each([
    ["self", "self.limit", { schema: maybe }],
    ["inputs", "inputs.limit", { inputType: jsonSchema(maybe) }],
  ])("is refused for a nullable `%s` chain", (root, chain, own) => {
    const found = wrap({ count: cel(chain) }, own);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`inputs.count: Telo.Definition/Wrap: CEL at 'inputs.count' reads '${chain}', which may be null`);
    expect(found[0]).toContain("target's declared inputType expects 'integer'");
  });

  it("reports a map written as one expression once, against the target's inputType", () => {
    expect(wrap(cel("'abc'"))).toEqual([
      "inputs: Telo.Definition/Wrap: CEL at 'inputs' returns 'string' " +
        "but target's declared inputType expects 'object'.",
    ]);
  });

  it("accepts an expression that fits", () => {
    const sized = { type: "object", properties: { size: { type: "integer" } } };
    expect(wrap({ count: cel("self.size"), label: cel("'x'") }, { schema: sized })).toEqual([]);
  });
});

describe("a path that is both an own field and a call-site slot", () => {
  const whole = (target: Record<string, any>, expression: string) =>
    analyze([
      {
        kind: "srv.Value",
        metadata: { name: "produce" },
        outputType: jsonSchema({
          type: "object",
          properties: { error: { type: ["object", "null"] } },
        }),
        value: {},
      },
      target,
      sequence([
        { name: "made", invoke: ref("produce") },
        { name: "call", invoke: ref((target.metadata as { name: string }).name), inputs: cel(expression) },
      ]),
    ]);

  it.each([
    ["a nullable chain", "steps.made.result.error", "which may be null, but consume's declared inputType expects 'object'"],
    ["a string", "'abc'", "returns 'string' but consume's declared inputType expects 'object'"],
  ])("reports %s once, against the target's inputType", (written, expression, said) => {
    const found = whole(consume, expression);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`steps[1].inputs: srv.Sequence/main: CEL at 'steps[1].inputs'`);
    expect(found[0]).toContain(said);
  });

  it("reports a string once against the field, where the target declares no inputType", () => {
    const open = { kind: "srv.Value", metadata: { name: "open" }, value: {} };
    expect(whole(open, "'abc'")).toEqual([
      "steps[1].inputs: srv.Sequence/main: CEL at 'steps[1].inputs' returns 'string' but the field expects 'object'.",
    ]);
  });
});
