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

describe("an x-telo-schema-from slot derives its schema with the source's hoisted fragments", () => {
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

  it("reports a derived schema that does not compile at the slot, naming its source", () => {
    // An author's own local definition resolves in the carrier, not where the
    // node is transplanted.
    const broken = carrier({ $ref: "#/$defs/Shape" }, { Shape: { type: "object" } });
    const errors = errorsOf(manifests(broken, [{ request: { method: "GET", schema: {} } }]));
    expect(errors).toEqual([
      {
        code: "SCHEMA_COMPILE_ERROR",
        message:
          "Srv.Api/api: 'routes[0].request' takes its schema from 'Carrier.Request/$defs/Matcher', which failed to compile: can't resolve reference #/$defs/Shape from id #",
        path: "routes[0].request",
      },
    ]);
  });
});
