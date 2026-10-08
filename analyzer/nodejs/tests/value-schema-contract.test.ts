import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { AnalysisDiagnostic, ManifestSource } from "../src/types.js";
import { resolveContractValueSchemas, type ValueSchemaHost } from "../src/value-schema-slot.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * Caller data typed where it is read: `x-telo-value-schema-from` inside an
 * `inputType`, naming the type field a reader of that data declares. The
 * fixture kinds are the whole mechanism — nothing in the analyzer names them.
 */

const TYPE_FIELD = { "x-telo-ref": { kind: "Telo.Type", use: "schema" } };

/** Declares the type of the caller data it reads. */
const READER = {
  kind: "Telo.Definition",
  metadata: { name: "Reader", module: "test-fx" },
  capability: "Telo.Provider",
  schema: { type: "object", properties: { contextType: TYPE_FIELD } },
} as unknown as ResourceDefinition;

const contextInput = (from: string) => ({
  kind: "Telo.JsonSchema",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      context: { type: "object", default: {}, "x-telo-value-schema-from": from },
    },
  },
});

/** Its `context` input is whatever its own `contextType` declares. */
const TYPED = {
  kind: "Telo.Definition",
  metadata: { name: "Typed", module: "test-fx" },
  capability: "Telo.Invocable",
  schema: { type: "object", properties: { contextType: TYPE_FIELD } },
  inputType: contextInput("contextType"),
} as unknown as ResourceDefinition;

/** Its `context` input is what every reader it holds declares. */
const CALLER = {
  kind: "Telo.Definition",
  metadata: { name: "Caller", module: "test-fx" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      readers: {
        type: "array",
        items: { "x-telo-ref": { kind: "test-fx.Reader", use: "dependency" } },
      },
    },
  },
  inputType: contextInput("/readers/*/contextType"),
} as unknown as ResourceDefinition;

const HOST = {
  kind: "Telo.Definition",
  metadata: { name: "Host", module: "test-fx" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      target: { "x-telo-ref": { kind: "Telo.Executable", use: "trigger.inbound", inputs: "/inputs" } },
      inputs: { type: "object", additionalProperties: true, "x-telo-eval": "runtime" },
    },
  },
} as unknown as ResourceDefinition;

const requires = (key: string) => ({
  kind: "Telo.JsonSchema",
  schema: { type: "object", required: [key], properties: { [key]: { type: "string" } } },
});

const app = (name: string, kind: string, body: Record<string, unknown>): ResourceManifest =>
  ({ kind, metadata: { name, module: "app" }, ...body }) as unknown as ResourceManifest;

const call = (target: { kind: string; name: string }, inputs: Record<string, unknown>) =>
  app("host", "Fx.Host", { target, inputs });

function analyze(
  resources: ResourceManifest[],
  definitions: ResourceDefinition[] = [READER, TYPED, CALLER, HOST],
): AnalysisDiagnostic[] {
  const registry = new AnalysisRegistry();
  registry.registerModuleIdentity("std", "test-fx");
  registry.registerModuleIdentity("std", "app");
  registry.registerImport("Fx", "test-fx", definitions.map((d) => d.metadata.name as string));
  for (const definition of definitions) registry.registerDefinition(definition);
  const root = { kind: "Telo.Application", metadata: { name: "App" } } as unknown as ResourceManifest;
  return new StaticAnalyzer().analyze(withSyntheticPositions([root, ...resources]), undefined, registry);
}

const mismatches = (diagnostics: AnalysisDiagnostic[]) =>
  diagnostics.filter((d) => d.code === "CONTRACT_INPUTS_MISMATCH");

describe("x-telo-value-schema-from inside a contract", () => {
  it("holds an omitted input, filled with its default, to the type the target declares", () => {
    const typed = app("typed", "Fx.Typed", { contextType: requires("turnId") });
    const found = mismatches(analyze([typed, call({ kind: "Fx.Typed", name: "typed" }, {})]));
    expect(found.map((d) => d.data?.path)).toEqual(["inputs"]);
    expect(found[0]!.message).toContain("turnId");
  });

  it("combines every type a `*` pointer reaches across references", () => {
    const readers = [
      app("turns", "Fx.Reader", { contextType: requires("turnId") }),
      app("sessions", "Fx.Reader", { contextType: requires("sessionId") }),
      app("untyped", "Fx.Reader", {}),
    ];
    const caller = app("caller", "Fx.Caller", {
      readers: readers.map((r) => ({ kind: "Fx.Reader", name: r.metadata.name })),
    });
    const target = { kind: "Fx.Caller", name: "caller" };

    const partial = mismatches(
      analyze([...readers, caller, call(target, { context: { turnId: "t1" } })]),
    );
    expect(partial.map((d) => d.data?.path)).toEqual(["inputs.context"]);
    expect(partial[0]!.message).toContain("sessionId");

    expect(
      mismatches(
        analyze([...readers, caller, call(target, { context: { turnId: "t1", sessionId: "s1" } })]),
      ),
    ).toEqual([]);
  });

  it("leaves the node unconstrained when the location reaches no type", () => {
    const caller = app("caller", "Fx.Caller", {
      readers: [{ kind: "Fx.Reader", name: "untyped" }],
    });
    expect(
      mismatches(
        analyze([
          app("untyped", "Fx.Reader", {}),
          caller,
          call({ kind: "Fx.Caller", name: "caller" }, { context: { anything: 1 } }),
        ]),
      ),
    ).toEqual([]);
  });

  it("refuses a location the kind's schema cannot reach", () => {
    const misnamed = {
      ...CALLER,
      metadata: { name: "Misnamed", module: "App" },
      inputType: contextInput("/reader/*/contextType"),
    } as unknown as ResourceDefinition;
    const found = analyze([misnamed as unknown as ResourceManifest]).filter(
      (d) => d.code === "VALUE_SCHEMA_FROM_INVALID",
    );
    expect(found.map((d) => d.data?.path)).toEqual([
      "inputType.schema.properties.context.x-telo-value-schema-from",
    ]);
  });

  it("refuses an unreachable location on a configuration slot too", () => {
    const misnamed = {
      kind: "Telo.Definition",
      metadata: { name: "MisnamedSlot", module: "App" },
      capability: "Telo.Provider",
      schema: {
        type: "object",
        properties: {
          contextType: TYPE_FIELD,
          context: { type: "object", "x-telo-value-schema-from": "contxtType" },
        },
      },
    } as unknown as ResourceManifest;
    const found = analyze([misnamed]).filter((d) => d.code === "VALUE_SCHEMA_FROM_INVALID");
    expect(found.map((d) => d.data?.path)).toEqual([
      "schema.properties.context.x-telo-value-schema-from",
    ]);
  });

  describe("a type field naming a shape", () => {
    const turn = (type: string) => ({
      type: "object",
      required: ["turnId"],
      properties: { turnId: { type } },
    });
    // Another module's shape of the same name, which `turnId: 42` violates.
    const elsewhere = {
      kind: "Telo.JsonSchema",
      metadata: { name: "Shape", module: "other" },
      schema: turn("string"),
    } as unknown as ResourceManifest;
    const found = (contextType: unknown, turnId: unknown) =>
      mismatches(
        analyze([
          elsewhere,
          app("typed", "Fx.Typed", { contextType }),
          call({ kind: "Fx.Typed", name: "typed" }, { context: { turnId } }),
        ]),
      ).map((d) => d.data?.path);

    it.each([
      ["an unstamped reference", { kind: "Telo.JsonSchema", name: "Shape" }],
      [
        "a module-scoped id whose module is absent",
        { kind: "Telo.JsonSchema", name: "Shape", $ref: "telo:absent/Shape" },
      ],
      ["a bare string", "Shape"],
    ])("contributes nothing for %s the holder's module does not declare", (_spelling, contextType) => {
      expect(found(contextType, "t1")).toEqual([]);
      expect(found(contextType, 42)).toEqual([]);
    });

    it("still types by an inline type, a raw schema and an id whose module is present", () => {
      const typing = {
        inline: { kind: "Telo.JsonSchema", schema: turn("string") },
        raw: turn("string"),
        presentModule: { kind: "Telo.JsonSchema", name: "Shape", $ref: "telo:other/Shape" },
      };
      for (const [form, contextType] of Object.entries(typing)) {
        expect([form, found(contextType, "t1")]).toEqual([form, []]);
        expect([form, found(contextType, 42)]).toEqual([form, ["inputs.context.turnId"]]);
      }
    });
  });

  const invalid = (diagnostics: AnalysisDiagnostic[]) =>
    diagnostics
      .filter((d) => d.code === "VALUE_SCHEMA_FROM_INVALID")
      .map((d) => [d.data?.resource?.name, d.data?.path]);

  it("judges a named shape's annotation against each kind that names the shape", () => {
    const shape = {
      kind: "Telo.JsonSchema",
      metadata: { name: "CallerInput", module: "App" },
      schema: {
        type: "object",
        properties: {
          context: { type: "object", "x-telo-value-schema-from": "/readers/*/contextType" },
        },
      },
    } as unknown as ResourceManifest;
    const naming = (name: string, field: string) =>
      ({
        kind: "Telo.Definition",
        metadata: { name, module: "App" },
        capability: "Telo.Invocable",
        schema: { type: "object", properties: { [field]: CALLER.schema!.properties!.readers } },
        inputType: { kind: "Telo.JsonSchema", name: "CallerInput" },
      }) as unknown as ResourceManifest;

    expect(invalid(analyze([shape, naming("Holds", "readers"), naming("Lacks", "reader")]))).toEqual([
      ["Lacks", "inputType"],
    ]);
  });

  it("tells a property named like a data keyword from the keyword's value", () => {
    const kind = (properties: Record<string, unknown>) =>
      ({
        kind: "Telo.Definition",
        metadata: { name: "Named", module: "App" },
        capability: "Telo.Invocable",
        schema: { type: "object" },
        inputType: { kind: "Telo.JsonSchema", schema: { type: "object", properties } },
      }) as unknown as ResourceManifest;
    const annotated = { type: "object", "x-telo-value-schema-from": "nowhere" };

    expect(invalid(analyze([kind({ default: annotated })]))).toEqual([
      ["Named", "inputType.schema.properties.default.x-telo-value-schema-from"],
    ]);
    expect(invalid(analyze([kind({ context: { type: "object", default: annotated } })]))).toEqual([]);
  });
});

describe("an expression at an argument a reached type declares", () => {
  const cel = (source: string) => ({ __tagged: true, engine: "cel", source });
  const declares = (properties: Record<string, unknown>) => ({
    kind: "Telo.JsonSchema",
    schema: { type: "object", properties },
  });
  const typeErrors = (diagnostics: AnalysisDiagnostic[]) =>
    diagnostics.filter((d) => d.code === "CEL_TYPE_ERROR").map((d) => d.data?.path);

  it("is held to that type", () => {
    const typed = app("typed", "Fx.Typed", { contextType: declares({ turnId: { type: "string" } }) });
    const target = { kind: "Fx.Typed", name: "typed" };
    const calling = (turnId: unknown) => analyze([typed, call(target, { context: { turnId } })]);

    expect(typeErrors(calling(cel("1 + 1")))).toEqual(["inputs.context.turnId"]);
    expect(typeErrors(calling(cel("'a' + 'b'")))).toEqual([]);
  });

  it("is reported once where several reached types declare it and one refuses it", () => {
    const readers = [
      app("texts", "Fx.Reader", { contextType: declares({ id: { type: "string" } }) }),
      app("counts", "Fx.Reader", { contextType: declares({ id: { type: "integer" } }) }),
    ];
    const caller = app("caller", "Fx.Caller", {
      readers: readers.map((r) => ({ kind: "Fx.Reader", name: r.metadata.name })),
    });
    const found = analyze([
      ...readers,
      caller,
      call({ kind: "Fx.Caller", name: "caller" }, { context: { id: cel("1 + 1") } }),
    ]);
    expect(typeErrors(found)).toEqual(["inputs.context.id"]);
  });

  it("judges an accessor chain by the schema of what it reads", () => {
    // The whole input is a record of the type the target names.
    const operation = {
      kind: "Telo.Definition",
      metadata: { name: "Operation", module: "test-fx" },
      capability: "Telo.Provider",
      schema: { type: "object", properties: { inputModel: TYPE_FIELD } },
      inputType: { type: "object", "x-telo-value-schema-from": "inputModel" },
    } as unknown as ResourceDefinition;
    const grid = {
      kind: "Telo.Definition",
      metadata: { name: "Grid", module: "test-fx" },
      capability: "Telo.Provider",
      schema: {
        type: "object",
        properties: {
          model: TYPE_FIELD,
          operation: { "x-telo-ref": { kind: "test-fx.Operation", use: "dependency", inputs: "/inputs" } },
          inputs: {
            type: "object",
            "x-telo-context": {
              type: "object",
              properties: { row: { "x-telo-context-from-root": "model" } },
            },
            additionalProperties: { "x-telo-eval": "accessor" },
          },
        },
      },
    } as unknown as ResourceDefinition;
    const archive = app("archive", "Fx.Operation", { inputModel: declares({ id: { type: "integer" } }) });
    const over = (id: unknown) =>
      analyze(
        [
          archive,
          app("grid", "Fx.Grid", {
            model: declares({ id: { type: "integer" }, name: { type: "string" } }),
            operation: { kind: "Fx.Operation", name: "archive" },
            inputs: { id },
          }),
        ],
        [operation, grid],
      );

    expect(typeErrors(over(cel("row.name")))).toEqual(["inputs.id"]);
    expect(typeErrors(over(cel("row.id")))).toEqual([]);
  });
});

describe("an expression at a member only a conjunct's map value declares", () => {
  const cel = (source: string) => ({ __tagged: true, engine: "cel", source });

  it("is typed in the document of the shape that declares the map value", () => {
    const plain = {
      kind: "Telo.Definition",
      metadata: { name: "Plain", module: "test-fx" },
      capability: "Telo.Invocable",
      schema: { type: "object", properties: { inputType: TYPE_FIELD } },
    } as unknown as ResourceDefinition;
    // The value of every member is a definition of the shape's own.
    const bag = app("Bag", "Telo.JsonSchema", {
      schema: {
        type: "object",
        $defs: { Id: { type: "string" } },
        additionalProperties: { $ref: "#/$defs/Id" },
      },
    });
    const target = app("plain", "Fx.Plain", {
      inputType: { type: "object", allOf: [{ $ref: "telo:app/Bag" }] },
    });
    const calling = (id: unknown) =>
      analyze([bag, target, call({ kind: "Fx.Plain", name: "plain" }, { id })], [plain, HOST])
        .filter((d) => d.code === "CEL_TYPE_ERROR")
        .map((d) => d.data?.path);

    expect(calling(cel("1 + 1"))).toEqual(["inputs.id"]);
    expect(calling(cel("'a' + 'b'"))).toEqual([]);
  });
});

describe("a contract typed by the declaration it is bound to", () => {
  const host: ValueSchemaHost = {
    scope: {
      resolveDefinition: () => undefined,
      resolveManifest: () => undefined,
      referenceSlots: () => [],
    },
    typeSchemaOf: (value) => (value as { schema?: Record<string, any> }).schema,
  };
  const type = {
    type: "object",
    properties: { turnId: { $ref: "#/$defs/Id" }, parent: { $ref: "#" } },
    $defs: { Id: { type: "string" } },
    default: { $ref: "#/$defs/Id" },
  };
  const declaration = { contextType: { kind: "Telo.JsonSchema", schema: type } };
  const annotated = { type: "object", "x-telo-value-schema-from": "contextType" };

  it("carries a reached type whole, its own references rebased onto its entry", () => {
    const contract = { type: "object", properties: { default: annotated } };
    const entry = "#/$defs/telo:value-schema-from:0";
    expect(resolveContractValueSchemas(contract, declaration, host)).toEqual({
      type: "object",
      properties: { default: { type: "object", allOf: [{ $ref: entry }] } },
      $defs: {
        "telo:value-schema-from:0": {
          type: "object",
          properties: { turnId: { $ref: `${entry}/$defs/Id` }, parent: { $ref: entry } },
          $defs: { Id: { type: "string" } },
          default: { $ref: "#/$defs/Id" },
        },
      },
    });
  });

  it("returns a contract no location typed by identity, a keyword's value included", () => {
    const contract = { type: "object", properties: { context: { type: "object", default: annotated } } };
    expect(resolveContractValueSchemas(contract, declaration, host)).toBe(contract);
  });
});

describe("a named type reached across an import", () => {
  const LIBRARY = `kind: Telo.Library
metadata: { name: Readers, version: 0.1.0 }
exports:
  resources: [reader, caller]
---
kind: Telo.JsonSchema
metadata: { name: TurnContext }
schema:
  type: object
  required: [turnId]
  properties:
    turnId: { type: string }
---
kind: Telo.Definition
metadata: { name: Reader }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    contextType:
      x-telo-ref: { kind: Telo.Type, use: schema }
---
kind: Telo.Definition
metadata: { name: Caller }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    additionalProperties: false
    properties:
      context:
        type: object
        default: {}
        x-telo-value-schema-from: /readers/*/contextType
schema:
  type: object
  properties:
    readers:
      type: array
      items:
        x-telo-ref: { kind: Self.Reader, use: dependency }
---
kind: Telo.Definition
metadata: { name: Holder }
capability: Telo.Provider
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    reader:
      x-telo-ref: { kind: Self.Reader, use: dependency }
    context:
      type: object
      x-telo-value-schema-from: /reader/contextType
---
kind: Telo.Definition
metadata: { name: Flow }
capability: Telo.Runnable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
schema:
  type: object
  properties:
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
---
kind: Self.Reader
metadata: { name: reader }
contextType: !ref TurnContext
---
kind: Self.Caller
metadata: { name: caller }
readers:
  - !ref reader
`;

  // The consumer's own shape of the same name means something else.
  const APP = `kind: Telo.Application
metadata: { name: App, version: 1.0.0 }
imports:
  Readers: ../lib/telo.yaml
---
kind: Telo.JsonSchema
metadata: { name: TurnContext }
schema:
  type: object
  required: [turnId]
  properties:
    turnId: { type: integer }
`;

  const source = (files: Record<string, string>): ManifestSource => ({
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  });

  async function errors(body: string) {
    const files = { "/lib/telo.yaml": LIBRARY, "/app/telo.yaml": APP + body };
    const graph = await new Loader([source(files)]).loadGraph("/app/telo.yaml", {
      desugarImports: true,
    });
    return new StaticAnalyzer()
      .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
      .filter((d) => d.severity === 1)
      .map((d) => [d.code, d.data?.path, d.message]);
  }

  const call = (turnId: string) => `---
kind: Readers.Flow
metadata: { name: flow }
steps:
  - name: call
    invoke: !ref Readers.caller
    inputs:
      context: { turnId: ${turnId} }
`;

  it("types a call by the shape the holder's module declares, not the consumer's of the same name", async () => {
    expect(await errors(call(`"t1"`))).toEqual([]);
    expect(await errors(call("42"))).toEqual([
      [
        "CONTRACT_INPUTS_MISMATCH",
        "steps[0].inputs.context.turnId",
        expect.stringContaining("/context/turnId must be string"),
      ],
    ]);
  });

  const holder = (turnId: string) => `---
kind: Readers.Holder
metadata: { name: holder }
reader: !ref Readers.reader
context: { turnId: ${turnId} }
`;

  it("holds a configuration slot to a library's own shape its location crosses into", async () => {
    expect(await errors(holder(`"t1"`))).toEqual([]);
    expect(await errors(holder("42"))).toEqual([
      ["SCHEMA_VIOLATION", "context.turnId", expect.stringContaining("/turnId must be string")],
    ]);
  });
});

describe("an annotation in a named shape reached through an import", () => {
  const SHAPES = `kind: Telo.Library
metadata: { name: Shapes, version: 0.1.0 }
exports:
  resources: [CallerInput]
---
kind: Telo.JsonSchema
metadata: { name: CallerInput }
schema:
  type: object
  properties:
    context:
      type: object
      x-telo-value-schema-from: /readers/*/contextType
`;
  const naming = (name: string, field: string) => `---
kind: Telo.Definition
metadata: { name: ${name} }
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
inputType: !ref Shared.CallerInput
schema:
  type: object
  properties:
    ${field}:
      type: array
      items:
        type: object
        properties:
          contextType:
            x-telo-ref: { kind: Telo.Type, use: schema }
`;
  const KINDS = `kind: Telo.Library
metadata: { name: Kinds, version: 0.1.0 }
imports:
  Shared: ../shapes/telo.yaml
${naming("Holds", "readers")}${naming("Lacks", "reader")}`;

  it("is judged per kind naming the shape, at that kind's own field", async () => {
    const files: Record<string, string> = { "/shapes/telo.yaml": SHAPES, "/kinds/telo.yaml": KINDS };
    const source: ManifestSource = {
      supports: () => true,
      async read(url: string) {
        const text = files[url];
        if (text === undefined) throw new Error(`File not found: ${url}`);
        return { text, source: url };
      },
      resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
    };
    const graph = await new Loader([source]).loadGraph("/kinds/telo.yaml", { desugarImports: true });
    const diagnostics = new StaticAnalyzer()
      .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
      .filter((d) => d.severity === 1);
    expect(diagnostics.map((d) => [d.code, d.data?.resource?.name, d.data?.path])).toEqual([
      ["VALUE_SCHEMA_FROM_INVALID", "Lacks", "inputType"],
    ]);
  });
});
