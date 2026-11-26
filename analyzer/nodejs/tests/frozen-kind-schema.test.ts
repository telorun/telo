import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import type { DefinitionRegistry } from "../src/definition-registry.js";
import { frozenWalkSchema } from "../src/frozen-kind-schema.js";
import { canonicalKindSchema } from "../src/schema-compile-findings.js";
import { celEvalSites, observeEvalSiteWalks } from "../src/eval-paths.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const manifests = withSyntheticPositions([
  { kind: "Telo.Application", metadata: { name: "App" } },
  {
    kind: "Telo.Definition",
    metadata: { name: "Greeter", module: "App" },
    capability: "Telo.Invocable",
    schema: {
      type: "object",
      properties: {
        greeting: { type: "string", "x-telo-eval": "runtime" },
        shape: { $ref: "telo://Self/Shape" },
      },
    },
    controllers: ["pkg:npm/@acme/greeter@1.0.0#Greeter"],
  },
  ...["a", "b", "c"].map((name) => ({
    kind: "App.Greeter",
    metadata: { name, module: "App" },
    greeting: makeTaggedSentinel("cel", "'hello'"),
  })),
] as unknown as ResourceManifest[]);

afterEach(() => observeEvalSiteWalks(undefined));

describe("a registered kind's schema", () => {
  it("is frozen: writing to it throws", () => {
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(manifests, { skipValidation: true }, registry);
    const schema = registry.resolveDefinition("App.Greeter")!.schema as Record<string, any>;
    expect(() => {
      schema.properties.greeting.type = "number";
    }).toThrow(TypeError);
    expect(() => {
      schema.title = "Greeter";
    }).toThrow(TypeError);
  });

  it("is the one object the schema compile, kind annotations and in-place cycle check read", () => {
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(manifests, { skipValidation: true }, registry);
    const document = manifests[1]!;
    const frozen = registry.resolveDefinition("App.Greeter")!.schema;
    const { defs } = registry as unknown as { defs: DefinitionRegistry };
    const scope = { defs, aliases: defs.aliases, aliasesByModule: defs.aliasesByModule, rootModules: defs.rootModules };
    expect(canonicalKindSchema(document, scope)).toBe(frozen);
    expect(frozenWalkSchema(defs, document)).toBe(frozen);
  });

  it("is walked for its eval sites once per analysis, however many resources read it", () => {
    const walks = new Map<object, number>();
    observeEvalSiteWalks((schema) => walks.set(schema, (walks.get(schema) ?? 0) + 1));
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(manifests, {}, registry);
    const schema = registry.resolveDefinition("App.Greeter")!.schema as object;
    expect(walks.get(schema)).toBe(1);
    expect([...walks.values()].every((count) => count === 1)).toBe(true);
  });

  it("is walked again only when a named shape it reached answers differently", () => {
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(manifests, { skipValidation: true }, registry);
    const schema = registry.resolveDefinition("App.Greeter")!.schema as Record<string, any>;
    let walked = 0;
    observeEvalSiteWalks((walkedSchema) => {
      if (walkedSchema === schema) walked++;
    });
    const before = { type: "object", properties: { at: { type: "string", "x-telo-eval": "compile" } } };
    const after = { type: "object", properties: { at: { type: "string", "x-telo-eval": "runtime" } } };
    let shape: Record<string, any> = before;
    const lookup = (id: string) => (id === "telo:App/Shape" ? shape : undefined);
    expect(celEvalSites(schema, lookup).compile).toContain("shape.at");
    expect(celEvalSites(schema, lookup).compile).toContain("shape.at");
    expect(walked).toBe(1);
    shape = after;
    expect(celEvalSites(schema, lookup).runtime).toContain("shape.at");
    expect(walked).toBe(2);
  });
});
