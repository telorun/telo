import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { AliasResolver } from "../src/alias-resolver.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { buildCallGraph, resourceId } from "../src/call-graph.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { createResolveCtx, resolveThrowsUnion } from "../src/resolve-throws-union.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * What the reach records at a pattern — every schema node it entered there, and
 * which of those are ALTERNATIVES (different branches of one `anyOf` / `oneOf`)
 * rather than conjuncts — as the consumers that read it see it: a slot's paired
 * `inputs:`, a case map's selector default, and a key a sibling branch gives a
 * value.
 */

const ref = (name: string) => makeTaggedSentinel("ref", name);

const app: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "App", version: "1.0.0" },
} as unknown as ResourceManifest;

const kind = (name: string, schema: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    kind: "Telo.Definition",
    metadata: { name, module: "App" },
    capability: "Telo.Invocable",
    ...extra,
    schema: { type: "object", ...schema },
  }) as unknown as ResourceManifest;

const analyze = (...manifests: ResourceManifest[]) =>
  new StaticAnalyzer().analyze(withSyntheticPositions([app, ...manifests]));

const codes = (diagnostics: { code?: string | number }[], ...wanted: string[]) =>
  diagnostics.filter((d) => wanted.includes(String(d.code))).map((d) => d.code);

describe("a paired `inputs:` is the slot's own pointer, at every reached shape", () => {
  // The slot's kind declares input `a`; the wired target requires `b`, which
  // only an author-written argument map can supply.
  const echo = kind(
    "Echo",
    { properties: { inputType: { type: "object" } } },
    { inputType: { type: "object", properties: { a: { type: "string" } } } },
  );
  const needsB = {
    kind: "App.Echo",
    metadata: { name: "needsB" },
    inputType: { type: "object", required: ["b"], properties: { b: { type: "string" } } },
  } as unknown as ResourceManifest;

  const pair = (paired: boolean) => ({
    type: "object",
    properties: {
      handler: {
        "x-telo-ref": { kind: "App.Echo", use: "call", ...(paired ? { inputs: "/inputs" } : {}) },
      },
      inputs: { type: "object", "x-telo-topology-role": "inputs" },
    },
  });
  const call = { handler: ref("needsB"), inputs: { b: "x" } };

  const shapes = (paired: boolean): Array<[string, Record<string, unknown>, Record<string, unknown>]> => [
    [
      "a `$ref`'d array item",
      { properties: { routes: { type: "array", items: { $ref: "#/$defs/Route" } } }, $defs: { Route: pair(paired) } },
      { routes: [call] },
    ],
    ["a root variant", { anyOf: [pair(paired)] }, call],
    ["a root `{}` value", { additionalProperties: pair(paired) }, { first: call }],
  ];

  const contractCodes = (schema: Record<string, unknown>, fields: Record<string, unknown>) =>
    codes(
      analyze(echo, needsB, kind("Router", schema), {
        kind: "App.Router",
        metadata: { name: "router" },
        ...fields,
      } as unknown as ResourceManifest),
      "CONTRACT_SLOT_INPUTS_UNSATISFIABLE",
      "CONTRACT_INPUTS_AT_RUN_SITE",
      "CONTRACT_INPUTS_MISMATCH",
    );

  it.each(shapes(true))("is checked at the call site, and satisfied there: %s", (_label, schema, fields) => {
    expect(contractCodes(schema, fields)).toEqual([]);
  });

  it.each(shapes(false))("without the pointer, is not paired: %s", (_label, schema, fields) => {
    expect(contractCodes(schema, fields)).toEqual(["CONTRACT_SLOT_INPUTS_UNSATISFIABLE"]);
  });
});

describe("a case map's selector default is read off the reach", () => {
  const raise = {
    kind: "Telo.Definition",
    metadata: { name: "Raise", module: "std" },
    capability: "Telo.Invocable",
    throws: { codes: { RAISED: {} } },
    schema: { type: "object", properties: {} },
  };
  const caseMap = { by: "/detach", cases: { false: "call", true: "detached" } };
  // The enclosing object: an omitted `detach:` defaults to `true` — detached,
  // which neither hands a failure back nor is an unresolved selector.
  const holder = (detachDefault?: boolean) => ({
    type: "object",
    properties: {
      ...(detachDefault === undefined ? {} : { detach: { type: "boolean", default: detachDefault } }),
      invoke: { "x-telo-ref": { kind: "std.Raise", use: caseMap } },
    },
  });
  const relay = (schema: Record<string, unknown>) => ({
    kind: "Telo.Definition",
    metadata: { name: "Relay", module: "std" },
    capability: "Telo.Invocable",
    throws: { inherit: true },
    schema: { type: "object", ...schema },
  });
  const anchor = {
    kind: "Telo.Definition",
    metadata: { name: "Outcomes", module: "std" },
    capability: "Telo.Type",
    schema: { type: "object", $defs: { Holder: holder(true) } },
  };
  const target = { kind: "std.Raise", metadata: { name: "raise" } };
  const toRaise = { kind: "std.Raise", name: "raise" };

  const shapes: Array<[string, Record<string, unknown>, Record<string, unknown>, string]> = [
    ["a plain property", { properties: { body: holder(true) } }, { body: { invoke: toRaise } }, "body.invoke"],
    ["a root `{}` value", { additionalProperties: holder(true) }, { first: { invoke: toRaise } }, "first.invoke"],
    [
      "a `#/definitions/` item",
      { properties: { body: { $ref: "#/definitions/Holder" } }, definitions: { Holder: holder(true) } },
      { body: { invoke: toRaise } },
      "body.invoke",
    ],
    [
      "a schema-from anchor",
      { properties: { body: { "x-telo-schema-from": "std.Outcomes/$defs/Holder" } } },
      { body: { invoke: toRaise } },
      "body.invoke",
    ],
  ];

  function edgeAt(schema: Record<string, unknown>, fields: Record<string, unknown>, path: string) {
    const registry = new DefinitionRegistry();
    for (const def of [raise, anchor, relay(schema)]) registry.register(def as never);
    const resources = [target, { kind: "std.Relay", metadata: { name: "relay" }, ...fields }];
    const graph = buildCallGraph(resources as unknown as ResourceManifest[], registry);
    return graph.edgesFrom(resourceId("std.Relay", "relay")).find((e) => e.path === path)!;
  }

  function throwsOf(schema: Record<string, unknown>, fields: Record<string, unknown>): string[] {
    const registry = new DefinitionRegistry();
    for (const def of [raise, anchor, relay(schema)]) registry.register(def as never);
    const resource = { kind: "std.Relay", metadata: { name: "relay" }, ...fields } as unknown as ResourceManifest;
    const ctx = createResolveCtx([target as unknown as ResourceManifest, resource], registry, new AliasResolver());
    return [...resolveThrowsUnion(resource, ctx).codes.keys()];
  }

  it.each(shapes)("classifies an omitted selector by its schema default: %s", (_label, schema, fields, path) => {
    const edge = edgeAt(schema, fields, path);
    expect(edge.use).toEqual(["detached"]);
    expect(edge.unresolved).toBeUndefined();
  });

  it.each(shapes.slice(0, 3))("the throws view agrees: %s", (_label, schema, fields) => {
    expect(throwsOf(schema, fields)).toEqual([]);
  });

  it("never reads a default a sibling alternative declares", () => {
    const schema = {
      anyOf: [
        { properties: { invoke: holder().properties.invoke } },
        { properties: { detach: { type: "boolean", default: true } } },
      ],
    };
    const fields = { invoke: toRaise };
    expect(edgeAt(schema, fields, "invoke").unresolvedReason).toBe("absent");
    // Absent, every case counts — `call` among them hands the failure back.
    expect(throwsOf(schema, fields)).toEqual(["RAISED"]);
  });
});

describe("a module-graph port's use is the slot's, at every reached shape", () => {
  const store = kind("Store", { properties: {} });
  const slot = { "x-telo-ref": { kind: "App.Store", use: "dependency" } };

  function portClass(schema: Record<string, unknown>): string | undefined {
    const manifests = withSyntheticPositions([
      { ...app, metadata: { ...app.metadata, module: "App" } } as unknown as ResourceManifest,
      store,
      kind("Holder", schema),
      { kind: "App.Store", metadata: { name: "db", module: "App" } } as unknown as ResourceManifest,
      {
        kind: "App.Holder",
        metadata: { name: "holder", module: "App" },
        store: ref("db"),
      } as unknown as ResourceManifest,
    ]);
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(manifests, {}, registry);
    const options = { entryModule: "App" };
    const graph = registry.analysisOf(manifests).moduleGraph(registry.moduleGraphDeps(manifests, options), options);
    return graph.nodes.find((n) => n.name === "holder")?.ports.find((p) => p.slot === "store")?.class;
  }

  it("holds through a `#/definitions/` slot exactly as through a plain one", () => {
    expect(portClass({ properties: { store: slot } })).toBe("holds");
    expect(portClass({ properties: { store: { $ref: "#/definitions/Store" } }, definitions: { Store: slot } })).toBe(
      "holds",
    );
  });
});

describe("a key a sibling branch gives a value", () => {
  const echo = kind("Echo", { properties: {} });
  const refNode = { "x-telo-ref": { kind: "App.Echo", use: "call" } };
  const union = (valueNode: Record<string, unknown>) => ({
    anyOf: [{ properties: { target: refNode } }, { properties: { target: valueNode } }],
  });

  const formCodes = (schema: Record<string, unknown>, fields: Record<string, unknown>) =>
    codes(
      analyze(echo, kind("Holder", schema), {
        kind: "App.Holder",
        metadata: { name: "holder" },
        ...fields,
      } as unknown as ResourceManifest),
      "INVALID_REFERENCE_FORM",
      "UNRESOLVED_REFERENCE",
      "SCHEMA_VIOLATION",
    );

  it("accepts a value that branch describes, at a root `anyOf`", () => {
    expect(formCodes(union({ type: "string" }), { target: "hello" })).toEqual([]);
  });

  it("still refuses a string no branch describes", () => {
    expect(formCodes(union({ type: "integer" }), { target: "hello" })).toEqual(["INVALID_REFERENCE_FORM"]);
  });

  it("accepts it under a property, the same union one level down", () => {
    const schema = { properties: { inner: { type: "object", ...union({ type: "string" }) } } };
    expect(formCodes(schema, { inner: { target: "hello" } })).toEqual([]);
  });

  it("accepts it at a `oneOf`", () => {
    const schema = {
      oneOf: [
        { required: ["mode"], properties: { mode: { const: "ref" }, target: refNode } },
        { required: ["mode"], properties: { mode: { const: "text" }, target: { type: "string" } } },
      ],
    };
    expect(formCodes(schema, { mode: "text", target: "hello" })).toEqual([]);
  });

  describe("only where the rest of the object fits the branch giving the value", () => {
    const discriminated = {
      oneOf: [
        { required: ["mode"], properties: { mode: { const: "ref" }, target: refNode } },
        { required: ["mode"], properties: { mode: { const: "text" }, target: { type: "string" } } },
      ],
    };

    it("at a root `oneOf`", () => {
      expect(formCodes(discriminated, { mode: "ref", target: "hello" })).toEqual(["INVALID_REFERENCE_FORM"]);
    });

    it("at a property's `oneOf`", () => {
      const schema = { properties: { inner: { type: "object", ...discriminated } } };
      expect(formCodes(schema, { inner: { mode: "ref", target: "hello" } })).toEqual([
        "INVALID_REFERENCE_FORM",
      ]);
      expect(formCodes(schema, { inner: { mode: "text", target: "hello" } })).toEqual([]);
    });

    it("at a union several objects above the slot, per array item", () => {
      const schema = {
        properties: {
          items: {
            type: "array",
            items: {
              oneOf: [
                {
                  required: ["mode"],
                  properties: { mode: { const: "ref" }, inner: { properties: { target: refNode } } },
                },
                {
                  required: ["mode"],
                  properties: { mode: { const: "text" }, inner: { properties: { target: { type: "string" } } } },
                },
              ],
            },
          },
        },
      };
      expect(
        formCodes(schema, {
          items: [
            { mode: "text", inner: { target: "hello" } },
            { mode: "ref", inner: { target: "hello" } },
          ],
        }),
      ).toEqual(["INVALID_REFERENCE_FORM"]);
    });
  });

  it("does not read an `allOf` member that only annotates the key as a value", () => {
    const schema = {
      allOf: [{ properties: { target: refNode } }, { properties: { target: { description: "The target." } } }],
    };
    expect(formCodes(schema, { target: "hello" })).toEqual(["INVALID_REFERENCE_FORM"]);
  });

  it("does not read a base property beside a branch as a value", () => {
    const schema = { properties: { target: refNode }, anyOf: [{ properties: { target: { type: "string" } } }] };
    expect(formCodes(schema, { target: "hello" })).toEqual(["INVALID_REFERENCE_FORM"]);
  });

  it("validates an alternative against the document it is declared in", () => {
    const schema = {
      ...union({ type: "string", not: { $ref: "#/$defs/Reserved" } }),
      $defs: { Reserved: { enum: ["none"] } },
    };
    expect(formCodes(schema, { target: "hello" })).toEqual([]);
  });

  it("still resolves a `!ref` written there", () => {
    expect(formCodes(union({ type: "string" }), { target: ref("nosuch") })).toEqual(["UNRESOLVED_REFERENCE"]);
  });
});
