import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { resolveContextAnnotations } from "../src/validate-cel-context.js";

describe("x-telo-context-from-root", () => {
  it("replaces the annotated property's schema with the schema at manifestRoot.<path>", () => {
    const manifestRoot = {
      kind: "Telo.Definition",
      schema: {
        type: "object",
        properties: { name: { type: "string" }, count: { type: "integer" } },
      },
    };

    const contextSchema = {
      type: "object",
      properties: {
        self: { "x-telo-context-from-root": "schema" },
      },
    };

    const resolved = resolveContextAnnotations(contextSchema, manifestRoot, {
      manifestRoot,
    });
    expect(resolved.properties.self).toEqual(manifestRoot.schema);
  });

  it("navigates from the root rather than the per-scope manifestItem", () => {
    // The manifestItem is a sub-slice (e.g. resources[0]); the annotation must
    // still resolve `schema` against the top-level Telo.Definition, not the
    // inner item.
    const innerSchemaShouldNotBeReturned = { type: "string" };
    const manifestRoot = {
      schema: { type: "object", properties: { real: { type: "boolean" } } },
      resources: [{ schema: innerSchemaShouldNotBeReturned }],
    };
    const manifestItem = manifestRoot.resources[0];

    const contextSchema = {
      type: "object",
      properties: { self: { "x-telo-context-from-root": "schema" } },
    };

    const resolved = resolveContextAnnotations(contextSchema, manifestItem, { manifestRoot });
    expect(resolved.properties.self).toEqual(manifestRoot.schema);
  });

  it("falls back to an open schema when the navigation path is missing", () => {
    const manifestRoot = { kind: "Telo.Definition" };
    const contextSchema = {
      type: "object",
      properties: { inputs: { "x-telo-context-from-root": "inputType" } },
    };

    const resolved = resolveContextAnnotations(contextSchema, manifestRoot, { manifestRoot });
    expect(resolved.properties.inputs).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });

  it("preserves existing `x-telo-context-from` semantics (back-compat)", () => {
    // Existing form: navigates manifestItem at the path, treats the result as a
    // *property map* to be merged into the annotated node's properties.
    const manifestItem = {
      request: {
        schema: {
          query: { type: "object", additionalProperties: true },
          body: { type: "object", additionalProperties: true },
        },
      },
    };

    const contextSchema = {
      type: "object",
      properties: {
        request: { "x-telo-context-from": "request/schema" },
      },
    };

    const resolved = resolveContextAnnotations(contextSchema, manifestItem);
    expect(resolved.properties.request.properties).toMatchObject({
      query: { type: "object", additionalProperties: true },
      body: { type: "object", additionalProperties: true },
    });
  });

  it("accepts back-compat third positional argument (Record<string,any>[] form)", () => {
    const manifestItem = {
      request: { schema: { q: { type: "string" } } },
    };
    const contextSchema = {
      type: "object",
      properties: { request: { "x-telo-context-from": "request/schema" } },
    };

    const resolved = resolveContextAnnotations(contextSchema, manifestItem, [] as ResourceManifest[]);
    expect(resolved.properties.request.properties.q).toEqual({ type: "string" });
  });
});

describe("x-telo-context-from-ref-kind", () => {
  it("resolves a sibling-field kind name to that kind's <field> schema", () => {
    const queryDef = {
      kind: "Telo.Definition",
      metadata: { name: "Query", module: "sql" },
      outputType: {
        type: "object",
        properties: { rows: { type: "array" } },
      },
    };
    const fakeDefs = {
      resolve(kind: string): Record<string, any> | undefined {
        return kind === "Sql.Query" ? queryDef : undefined;
      },
    };
    const fakeAliases = { resolveKind: () => undefined };

    const manifestRoot = { provide: { kind: "Sql.Query" } };

    const contextSchema = {
      type: "object",
      properties: {
        result: { "x-telo-context-from-ref-kind": "provide/kind#outputType" },
      },
    };

    const resolved = resolveContextAnnotations(contextSchema, manifestRoot, {
      manifestRoot,
      defs: fakeDefs,
      aliases: fakeAliases,
    });
    expect(resolved.properties.result).toEqual(queryDef.outputType);
  });

  it("falls back to an open schema when the kind cannot be resolved", () => {
    const fakeDefs = { resolve: () => undefined };
    const fakeAliases = { resolveKind: () => undefined };

    const manifestRoot = { provide: { kind: "Unknown.Kind" } };
    const contextSchema = {
      type: "object",
      properties: {
        result: { "x-telo-context-from-ref-kind": "provide/kind#outputType" },
      },
    };

    const resolved = resolveContextAnnotations(contextSchema, manifestRoot, {
      manifestRoot,
      defs: fakeDefs,
      aliases: fakeAliases,
    });
    expect(resolved.properties.result).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });
});
