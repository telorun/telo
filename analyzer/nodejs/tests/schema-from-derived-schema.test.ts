import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { expandManifestFragments } from "../src/manifest-schemas.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A carrier publishing `$defs/Matcher`, whose `schema` holds JSON Schema typed
 *  by the recursive fragment the loader hoists into the carrier's root. */
function carrier(matcherSchema: Record<string, unknown>, defs: Record<string, unknown> = {}): ResourceManifest {
  const definition = {
    kind: "Telo.Definition",
    metadata: { name: "Request", module: "AcmeCarrier" },
    capability: "Telo.Type",
    schema: {
      type: "object",
      $defs: {
        ...defs,
        Matcher: {
          type: "object",
          properties: { method: { type: "string", enum: ["GET", "POST"] }, schema: matcherSchema },
          required: ["method"],
        },
      },
    },
  };
  expandManifestFragments(definition);
  return definition as unknown as ResourceManifest;
}

const manifests = (carrierDef: ResourceManifest, routes: unknown): ResourceManifest[] =>
  [
    { kind: "Telo.Application", metadata: { name: "AcmeApp", version: "1.0.0" } },
    { kind: "Telo.Import", metadata: { name: "Srv", resolvedModuleName: "AcmeServer" }, source: "../server" },
    { kind: "Telo.Library", metadata: { name: "AcmeServer" }, exports: { kinds: ["Api"] } },
    {
      kind: "Telo.Import",
      metadata: { name: "Carrier", module: "AcmeServer", resolvedModuleName: "AcmeCarrier" },
      source: "../carrier",
    },
    {
      kind: "Telo.Definition",
      metadata: { name: "Api", module: "AcmeServer" },
      capability: "Telo.Mount",
      schema: {
        type: "object",
        properties: {
          routes: {
            type: "array",
            items: {
              type: "object",
              properties: { request: { "x-telo-schema-from": "Carrier.Request/$defs/Matcher" } },
            },
          },
        },
      },
    },
    { kind: "Telo.Library", metadata: { name: "AcmeCarrier" }, exports: { kinds: ["Request"] } },
    carrierDef,
    { kind: "Srv.Api", metadata: { name: "api" }, routes },
  ] as unknown as ResourceManifest[];

const errorsOf = (list: ResourceManifest[]) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions(list))
    .filter((d) => d.severity === 1)
    .map((d) => ({ code: d.code, message: d.message, path: (d.data as { path?: string } | undefined)?.path }));

describe("an x-telo-schema-from slot reads its schema where it sits in the source kind's schema", () => {
  const typed = carrier({
    type: "object",
    properties: { body: { $ref: "telo://manifest#/$defs/JsonSchema7" } },
  });

  it("compiles a source holding a recursive fragment and refuses a mismatch inside it", () => {
    const errors = errorsOf(
      manifests(typed, [
        {
          request: {
            method: "FOO",
            schema: { body: { type: "object", properties: { code: { type: "string", pattern: "^(?!tmp$)[a-z]+$" } } } },
          },
        },
      ]),
    );
    expect(errors).toEqual([
      {
        code: "DEPENDENT_SCHEMA_MISMATCH",
        message:
          "Srv.Api/api: 'routes[0].request' does not match schema from 'Carrier.Request/$defs/Matcher': /method must be equal to one of the allowed values (GET | POST)",
        path: "routes[0].request.method",
      },
      {
        code: "DEPENDENT_SCHEMA_MISMATCH",
        message:
          "Srv.Api/api: 'routes[0].request' does not match schema from 'Carrier.Request/$defs/Matcher': /schema/body/properties/code/pattern invalid RE2 pattern \"^(?!tmp$)[a-z]+$\": invalid or unsupported Perl syntax",
        path: "routes[0].request.schema.body.properties.code.pattern",
      },
    ]);
  });

  it("resolves an author's own local definition in the carrier, where the node is written", () => {
    const local = carrier({ $ref: "#/$defs/Shape" }, { Shape: { type: "object" } });
    expect(errorsOf(manifests(local, [{ request: { method: "GET", schema: {} } }]))).toEqual([]);
    expect(errorsOf(manifests(local, [{ request: { method: "GET", schema: 5 } }]))).toEqual([
      {
        code: "DEPENDENT_SCHEMA_MISMATCH",
        message:
          "Srv.Api/api: 'routes[0].request' does not match schema from 'Carrier.Request/$defs/Matcher': /schema must be object",
        path: "routes[0].request.schema",
      },
    ]);
  });

  it("reads a '#' the node writes as the carrier's root", () => {
    // Read as the matcher alone, `#` would ask `nested` for a `method`.
    const descending = carrier({ type: "object", properties: { nested: { $ref: "#" } } });
    expect(errorsOf(manifests(descending, [{ request: { method: "GET", schema: { nested: { root: 1 } } } }]))).toEqual([]);
    expect(errorsOf(manifests(descending, [{ request: { method: "GET", schema: { nested: 5 } } }]))).toEqual([
      {
        code: "DEPENDENT_SCHEMA_MISMATCH",
        message:
          "Srv.Api/api: 'routes[0].request' does not match schema from 'Carrier.Request/$defs/Matcher': /schema/nested must be object",
        path: "routes[0].request.schema.nested",
      },
    ]);
  });

  it("decodes an instance-typed literal at the pointer it reads, as the whole document would", () => {
    const timed = carrier({ type: "object", properties: { maxAge: { "x-telo-type": "Telo.Duration" } } });
    expect(errorsOf(manifests(timed, [{ request: { method: "GET", schema: { maxAge: "0s" } } }]))).toEqual([]);
  });
});
