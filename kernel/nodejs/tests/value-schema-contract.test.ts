import * as path from "path";
import { fileURLToPath } from "url";
import { valueSchemaFromProblems, type ProjectionScope } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import type { ContractValidatorFactory } from "../src/invocation-contract-binding.js";
import {
  bindContract,
  resolveBoundContract,
} from "../src/invocation-contract-binding.js";
import { SchemaValidator } from "../src/schema-validator.js";

/**
 * `x-telo-value-schema-from` inside an `inputType`, at dispatch: the node is
 * held to every type its location names, read off the declarations the bound
 * resource references. The fixture kinds are the whole mechanism.
 */

const contextInput = (from: string) => ({
  type: "object",
  properties: {
    context: { type: "object", default: {}, "x-telo-value-schema-from": from },
  },
});

const requires = (key: string) => ({
  kind: "Telo.JsonSchema",
  schema: { type: "object", required: [key], properties: { [key]: { type: "string" } } },
});

const turns = { kind: "fx.Reader", metadata: { name: "turns" }, contextType: requires("turnId") };
const sessions = {
  kind: "fx.Reader",
  metadata: { name: "sessions" },
  contextType: requires("sessionId"),
};
const untyped = { kind: "fx.Reader", metadata: { name: "untyped" } };
const readers = [turns, sessions, untyped];

const caller = {
  kind: "fx.Caller",
  metadata: { name: "caller" },
  readers: readers.map((reader) => ({ kind: reader.kind, name: reader.metadata.name })),
};

const scope: ProjectionScope = {
  resolveDefinition: () => ({}),
  resolveManifest: (value) => {
    const manifest = readers.find((r) => r.metadata.name === (value as { name?: string }).name);
    return manifest ? { manifest } : undefined;
  },
  referenceSlots: (declaration) =>
    declaration === caller ? caller.readers.map((_, index) => `readers[${index}]`) : [],
};

function factory(): ContractValidatorFactory {
  const validator = new SchemaValidator();
  return Object.assign((schema: unknown) => validator.compile(schema), {
    schemaOf: (typeRef: unknown) =>
      ((typeRef as { schema?: Record<string, any> }).schema ?? typeRef) as Record<string, any>,
    resolveRef: () => undefined,
    withRules: (name: string | undefined, schema: Record<string, any>) => validator.compile(schema),
  }) as ContractValidatorFactory;
}

function bound(manifest: Record<string, any>, from: string) {
  const definition = { kind: "Telo.Definition", inputType: contextInput(from) };
  const received: unknown[] = [];
  const instance = {
    invoke: async (inputs: unknown) => {
      received.push(inputs);
      return null;
    },
  };
  bindContract(instance as any, {
    input: resolveBoundContract(
      "inputType",
      manifest as any,
      definition as any,
      () => undefined,
      factory(),
      scope,
    ),
    describeTarget: () => "fx/target",
  });
  return { instance, received };
}

describe("a contract node typed by a declared type, at dispatch", () => {
  it("refuses an omitted input whose default does not satisfy the declared type", async () => {
    const { instance, received } = bound({ kind: "fx.Typed", contextType: requires("turnId") }, "contextType");
    await expect(instance.invoke({})).rejects.toMatchObject({ code: "ERR_INPUT_INVALID" });
    expect(received).toEqual([]);
    await instance.invoke({ context: { turnId: "t1" } });
    expect(received).toEqual([{ context: { turnId: "t1" } }]);
  });

  it("holds the node to every type a `*` pointer reaches across references", async () => {
    const { instance, received } = bound(caller, "/readers/*/contextType");
    await expect(instance.invoke({ context: { turnId: "t1" } })).rejects.toMatchObject({
      code: "ERR_INPUT_INVALID",
    });
    await instance.invoke({ context: { turnId: "t1", sessionId: "s1" } });
    expect(received).toEqual([{ context: { turnId: "t1", sessionId: "s1" } }]);
  });

  it("leaves the node as declared when the location reaches no type", async () => {
    const { instance, received } = bound({ kind: "fx.Typed" }, "contextType");
    await instance.invoke({});
    expect(received).toEqual([{ context: {} }]);
  });

  // A reached type is carried as an entry of the contract's `$defs`, so what a
  // contract walk reads off a declared node it must read through that entry.
  const settings = {
    kind: "Telo.JsonSchema",
    schema: {
      type: "object",
      properties: {
        depth: { type: "integer", default: 3 },
        token: { $ref: "#/$defs/Secret" },
      },
      $defs: { Secret: { type: "string", "x-telo-sensitive": true } },
    },
  };

  it("fills a default the reached type declares, without writing into the caller's value", async () => {
    const { instance, received } = bound({ kind: "fx.Typed", contextType: settings }, "contextType");
    const sent = { context: {} };
    await instance.invoke(sent);
    expect(received).toEqual([{ context: { depth: 3 } }]);
    expect(sent).toEqual({ context: {} });
  });

  it("fills a default on a property of the reached type's own definitions, in a container the caller sent", async () => {
    const nested = {
      kind: "Telo.JsonSchema",
      schema: {
        type: "object",
        properties: { options: { $ref: "#/$defs/Options" } },
        $defs: {
          Options: { type: "object", properties: { depth: { type: "integer", default: 3 } } },
        },
      },
    };
    const { instance, received } = bound({ kind: "fx.Typed", contextType: nested }, "contextType");
    const sent = { context: { options: {} } };
    await instance.invoke(sent);
    expect(received).toEqual([{ context: { options: { depth: 3 } } }]);
    expect(sent).toEqual({ context: { options: {} } });
  });

  it("reads a sensitive mark behind the reached type's own definitions", () => {
    const contract = resolveBoundContract(
      "inputType",
      { kind: "fx.Typed", contextType: settings } as any,
      { kind: "Telo.Definition", inputType: contextInput("contextType") } as any,
      () => undefined,
      factory(),
      scope,
    );
    expect(contract!.sensitivePaths()).toEqual([["context", "token"]]);
  });
});

describe("the named shape a kind's contract field names, at registration", () => {
  const fixture = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "__fixtures__/value-schema-shape/telo.yaml",
  );

  it("is read across an import with its parents folded, from the load's declarations alone", async () => {
    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    // Loaded and never booted: no shape is created and no import initialized.
    await kernel.load(fixture);
    // The library's kind as registration holds it, its reference resolved.
    const definition = {
      kind: "Telo.Definition",
      metadata: { name: "Caller", module: "ValueSchemaShapeKinds" },
      inputType: {
        kind: "Telo.JsonSchema",
        name: "CallerInput",
        alias: "Shared",
        $ref: "telo:ValueSchemaShapes/CallerInput",
      },
      schema: { type: "object", properties: { readers: { type: "array", items: { type: "object" } } } },
    };

    const problems = valueSchemaFromProblems(definition, definition.schema, (typeField) =>
      kernel.resolveNamedContractShape(typeField, definition),
    );

    expect(problems.map((problem) => problem.path)).toEqual(["inputType"]);
    expect(problems[0]!.message).toContain("/reader/*/contextType");
    await expect(kernel.boot()).rejects.toThrow(/x-telo-value-schema-from: \/reader\/\*\/contextType/);
  });
});
