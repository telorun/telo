import type { ResourceDefinition, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { AliasResolver } from "../src/alias-resolver.js";

/**
 * The scope query — the way into the CEL scope rule from outside the analysis
 * pass. What it must get right is that it answers for an ADDRESS rather than
 * for a walked expression, since an IDE's cursor is frequently sitting in an
 * expression the last analysis never saw.
 */

const SEQUENCE_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "test-run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        "x-telo-step-context": { invoke: "invoke", outputType: "outputType" },
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            invoke: { "x-telo-ref": "telo#Invocable" },
            then: { type: "array", "x-telo-topology-role": "branch" },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const APP: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "TestApp", module: "test-run" },
  variables: { greeting: { env: "GREETING", type: "string" } },
} as unknown as ResourceManifest;

const SEQUENCE: ResourceManifest = {
  kind: "Run.Sequence",
  metadata: { name: "flow", module: "test-run" },
  steps: [
    { name: "first", invoke: { kind: "Telo.Invocable", name: "x" } },
    { name: "wrapper", then: [{ name: "nested", invoke: { kind: "Telo.Invocable", name: "y" } }] },
  ],
} as unknown as ResourceManifest;

function registry(): AnalysisRegistry {
  const r = new AnalysisRegistry();
  r.registerModuleIdentity("std", "test-run");
  r.registerImport("Run", "test-run", ["Sequence"]);
  r.registerDefinition(SEQUENCE_DEF);
  return r;
}

describe("CelScopeQuery", () => {
  const manifests = [APP, SEQUENCE];

  it("types a site the analysis never walked — the live-typing case", () => {
    const query = registry().analysisOf(manifests).celScope;
    const resource = query.resourceFor("Run.Sequence", "flow")!;
    // A path carrying no expression at all: this is what a cursor in a
    // half-written `!cel` addresses.
    const scope = query.scopeAt(resource, "steps[0].inputs.q");
    const names = scope.env.getDefinitions().variables.map((v) => v.name);
    expect(names).toContain("variables");
  });

  it("puts each step's result in scope", () => {
    const query = registry().analysisOf(manifests).celScope;
    const resource = query.resourceFor("Run.Sequence", "flow")!;
    const scope = query.scopeAt(resource, "steps[1].inputs.q");
    const steps = scope.contextSchema?.properties?.steps?.properties;
    expect(Object.keys(steps ?? {}).sort()).toEqual(["first", "nested"]);
  });

  it("locates a step's declaration, including one nested in a branch", () => {
    const query = registry().analysisOf(manifests).celScope;
    const resource = query.resourceFor("Run.Sequence", "flow")!;
    expect(query.stepDeclarationPath(resource, "first")).toBe("steps[0]");
    expect(query.stepDeclarationPath(resource, "nested")).toBe("steps[1].then[0]");
    expect(query.stepDeclarationPath(resource, "absent")).toBeUndefined();
  });

  it("reports no resource for a document the analyzed set does not hold", () => {
    const query = registry().analysisOf(manifests).celScope;
    expect(query.resourceFor("Run.Sequence", "brand-new")).toBeUndefined();
  });
});

/**
 * A LIBRARY'S OWN RESOURCE, asked about from outside the pass.
 *
 * An application analysis is flattened, so an imported library's exported
 * instances are queried in the consumer's scope — but the kind on such a resource
 * is spelled through the alias the LIBRARY declared, which the consumer has no
 * reason to have. Resolving it through the entry's aliases finds no definition,
 * and everything this query offers is read off the definition: a route's
 * `request` / `result` bindings simply do not appear.
 *
 * That is the same omission the pass had, and it matters more here, because a
 * completion list is a claim that the name it offers will pass `telo check`. The
 * checker having been fixed and the query not would have made the editor silent
 * at exactly the sites the checker had started accepting.
 */
const API_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "test-http" },
  capability: "Telo.Mount",
  schema: {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            request: { type: "object" },
            inputs: {
              type: "object",
              additionalProperties: true,
              "x-telo-context": {
                type: "object",
                additionalProperties: false,
                properties: {
                  request: {
                    "x-telo-context-from": "request/schema",
                    type: "object",
                    properties: { query: { type: "object", additionalProperties: true } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

/** Declared inside a library that imports the transport as `Http` — an alias the
 *  consuming application never declares. */
const LIBRARY_ROUTE: ResourceManifest = {
  kind: "Http.Api",
  metadata: { name: "greetApi", module: "test-lib", forwardedExport: true },
  routes: [
    {
      request: {
        path: "/greet",
        schema: { query: { type: "object", properties: { name: { type: "string" } } } },
      },
      inputs: { name: "" },
    },
  ],
} as unknown as ResourceManifest;

describe("CelScopeQuery over a forwarded library resource", () => {
  function consumerRegistry(): AnalysisRegistry {
    const r = new AnalysisRegistry();
    r.registerModuleIdentity("std", "test-http");
    r.registerDefinition(API_DEF);
    // The CONSUMER imports the library only. `Http` exists solely in the
    // library's own scope, which is what the entry's alias table cannot answer.
    r.registerImport("Routes", "test-lib", ["Api"]);
    const libScope = new AliasResolver();
    libScope.registerImport("Http", "test-http", ["Api"]);
    r._context().aliasesByModule!.set("test-lib", libScope);
    return r;
  }

  it("offers the kind's context bindings inside a route the library declared", () => {
    const query = consumerRegistry().analysisOf([LIBRARY_ROUTE]).celScope;
    const resource = query.resourceFor("Http.Api", "greetApi")!;
    const scope = query.scopeAt(resource, "routes[0].inputs.name");
    expect(Object.keys(scope.contextSchema?.properties ?? {})).toContain("request");
  });
});

/**
 * TWO LIBRARIES, ONE KIND NAME.
 *
 * A definition's name is unique inside its module and not across the flattened
 * set, so an annotation that resolves a kind to `<module>.<Kind>` and then looks
 * the definition up by the bare suffix picks whichever manifest came first. The
 * editor then types a context region off another library's annotations — the
 * silent wrong answer, not a missing one.
 */
const OTHER_API_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Api", module: "other-http" },
  capability: "Telo.Mount",
  schema: { type: "object", properties: {} },
  outputType: { type: "object", properties: { field: { type: "integer" } } },
} as unknown as ResourceDefinition;

/** The `test-http` one, with the same name and an `outputType` of its own — the
 *  node a declaration site must land on. */
const HTTP_API_WITH_OUTPUT: ResourceDefinition = {
  ...(API_DEF as unknown as Record<string, unknown>),
  outputType: { type: "object", properties: { field: { type: "string" } } },
} as unknown as ResourceDefinition;

/** A kind whose `x-telo-context` types a binding from the kind NAMED in a
 *  sibling field — the annotation that resolves a kind and then has to find its
 *  declaration. */
const DISPATCH_DEF: ResourceDefinition = {
  kind: "Telo.Definition",
  metadata: { name: "Dispatch", module: "test-lib" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      targetKind: { type: "string" },
      inputs: {
        type: "object",
        additionalProperties: true,
        "x-telo-context": {
          type: "object",
          properties: {
            result: { "x-telo-context-from-ref-kind": "targetKind#outputType" },
          },
        },
      },
    },
  },
} as unknown as ResourceDefinition;

const DISPATCHER: ResourceManifest = {
  kind: "Lib.Dispatch",
  metadata: { name: "call", module: "test-lib", forwardedExport: true },
  targetKind: "Http.Api",
  inputs: { x: "" },
} as unknown as ResourceManifest;

describe("CelScopeQuery resolving a kind that two modules declare", () => {
  it("finds the declaration in the module the kind resolved to", () => {
    const r = new AnalysisRegistry();
    r.registerModuleIdentity("std", "test-http");
    r.registerDefinition(HTTP_API_WITH_OUTPUT);
    r.registerDefinition(OTHER_API_DEF);
    r.registerDefinition(DISPATCH_DEF);
    r.registerImport("Routes", "test-lib", ["Dispatch"]);
    const libScope = new AliasResolver();
    libScope.registerImport("Http", "test-http", ["Api"]);
    libScope.registerUngatedAlias("Lib", "test-lib");
    r._context().aliasesByModule!.set("test-lib", libScope);

    // `OTHER_API_DEF` is listed FIRST, so a bare-name lookup returns it — which
    // is what makes this a real assertion rather than an accident of order.
    const manifests = [
      OTHER_API_DEF as unknown as ResourceManifest,
      HTTP_API_WITH_OUTPUT as unknown as ResourceManifest,
      DISPATCHER,
    ];
    const query = r.analysisOf(manifests).celScope;
    const resource = query.resourceFor("Lib.Dispatch", "call")!;
    const site = query.contextDeclarationSite(resource, "inputs.x", ["result", "field"]);
    expect(site?.name).toBe("Api");
    // The one that matters: WHICH `Api`. The module is part of the site's
    // identity for the same reason it is part of the lookup — `(kind, name)`
    // alone would send go-to-declaration into the other library's file.
    expect(site?.module).toBe("test-http");
  });
});
