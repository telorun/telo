import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AnalysisRegistry,
  collectModuleDocuments,
  flattenForAnalyzer,
  isResolvedReference,
  Loader,
  emittedInlineName,
  normalizeInlineResources,
  readExpansionSites,
  readTemplateConsumers,
  StaticAnalyzer,
  type ManifestSource,
} from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { expandTemplateInstance } from "../src/controllers/resource-definition/template-instance-expansion.js";
import { ModuleContext } from "../src/module-context.js";
import { recordInstanceDeclaration, recordOutermostDeclaration } from "../src/instance-declaration.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/template-expansion");

const fileSource: ManifestSource = {
  supports: (url) => isAbsolute(url),
  async read(url) {
    const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
    return { text: readFileSync(file, "utf8"), source: file };
  },
  resolveRelative: (base, relative) => resolve(dirname(base), relative),
};

/** Both callers' view of one fixture: the analyzer's consumer check, and the kernel's
 *  instance expansion over the same consumers with live instances in their slots. */
async function load(file: string) {
  const graph = await new Loader([fileSource]).loadGraph(join(FIXTURES, file), { desugarImports: true });
  const flat = flattenForAnalyzer(graph);
  const registry = new AnalysisRegistry();
  const analyzer = new StaticAnalyzer();
  analyzer.analyze(flat, { moduleDocuments: collectModuleDocuments(graph) }, registry);
  const manifests = analyzer.normalize(flat, registry);
  const context = registry._context();
  const analysis = {
    definitions: context.definitions!,
    aliases: context.aliases!,
    aliasesByModule: context.aliasesByModule ?? new Map(),
  };
  const rootModules = new Set(manifests.filter((m) => m.kind === "Telo.Application").map((m) => m.metadata.name));
  const consumers = readTemplateConsumers({
    manifests,
    registry: analysis.definitions,
    aliases: analysis.aliases,
    aliasesByModule: analysis.aliasesByModule,
    rootModules,
    decidedValue: () => undefined,
  });
  return { manifests, analysis, consumers };
}

/** `value` with each resolved reference replaced by a live stand-in recording
 *  the declaration it names. */
function live(value: unknown, manifests: readonly ResourceManifest[]): unknown {
  if (isResolvedReference(value)) {
    const stand = { __live: value.name };
    const declaration = manifests.find((m) => m.metadata?.name === value.name);
    if (declaration) {
      recordInstanceDeclaration(stand, declaration);
      recordOutermostDeclaration(stand, declaration);
    }
    return stand;
  }
  if (Array.isArray(value)) return value.map((v) => live(v, manifests));
  if (value && typeof value === "object" && !(value as { __compiled?: unknown }).__compiled) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, live(v, manifests)]));
  }
  return value;
}

/** An expansion's body with every leaf that differs by seam reduced to what it names. */
function plain(value: unknown, holders: (holder: unknown, keys: readonly (string | number)[]) => unknown): unknown {
  if (value && typeof value === "object") {
    const v = value as Record<string, any>;
    if (v.__templateForward) return plain(holders(v.__templateForward.holder, v.__templateForward.keys), holders);
    if (v.__live) return { ref: v.__live };
    if (isResolvedReference(value)) return { ref: v.name };
    if (v.__compiled) return { cel: v.source };
    if (Array.isArray(value)) return value.map((x) => plain(x, holders));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x, holders)]));
  }
  return value;
}

const at = (holder: unknown, keys: readonly (string | number)[]) =>
  keys.reduce<any>((cur, key) => cur?.[key], holder);

describe("a template instance expanded by the analyzer's consumer check and by the kernel", () => {
  it("expands the routes and servers examples to the same body, with the same names", async () => {
    const { manifests, analysis, consumers } = await load("callers.yaml");
    expect(consumers.diagnostics).toEqual([]);
    expect(consumers.expansions.size).toBe(3);
    for (const [consumer, expanded] of consumers.expansions) {
      const reading = readExpansionSites(
        [expanded.runner as unknown as ResourceManifest],
        [],
        analysis.definitions,
        analysis.aliases,
        analysis.aliasesByModule,
        true,
      );
      const sites = new Map(reading.sites.filter((s) => s.refusal === undefined).map((s) => [s.value, s]));
      const kernel = expandTemplateInstance({
        resource: live(consumer, manifests) as ResourceManifest,
        definition: expanded.runner,
        sites,
        analysis,
        definingContext: { isNeed: () => false } as never,
        consumerContext: {} as never,
        referenceSitesOf: () => [],
        stampDeclaringModule: (entry) => entry,
      });
      // The analyzer forwards a value as a marker; the kernel hands the live one.
      expect(plain(kernel.definition, at)).toEqual(plain(expanded.expansion.definition, at));
      expect(kernel.mappings).toEqual(expanded.expansion.mappings);
    }
  });

  it("refuses what the analyzer's check refuses, all of it, with the same diagnostics", async () => {
    const { analysis, consumers, manifests } = await load("refusals.yaml");
    expect(consumers.diagnostics.map((d) => d.code).sort()).toEqual(["BRANCH_UNDECIDABLE", "REPEAT_COMPUTED"]);
    const [consumer, expanded] = [...consumers.expansions][0]!;
    const reading = readExpansionSites(
      [expanded.runner as unknown as ResourceManifest],
      [],
      analysis.definitions,
      analysis.aliases,
      analysis.aliasesByModule,
      true,
    );
    const sites = new Map(reading.sites.filter((s) => s.refusal === undefined).map((s) => [s.value, s]));
    let thrown: any;
    try {
      expandTemplateInstance({
        resource: live(consumer, manifests) as ResourceManifest,
        definition: expanded.runner,
        sites,
        analysis,
        definingContext: { isNeed: () => false } as never,
        consumerContext: { expandWith: () => undefined } as never,
        referenceSitesOf: () => [],
        stampDeclaringModule: (entry) => entry,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.code).toBe("ERR_MANIFEST_VALIDATION_FAILED");
    expect(thrown.message.split("\n").sort()).toEqual(consumers.diagnostics.map((d) => d.message).sort());
  });

  it("renders the refusals of an init()-time expansion as the root cause of the failed initialization", async () => {
    const { analysis, consumers, manifests } = await load("refusals.yaml");
    const [consumer, expanded] = [...consumers.expansions][0]!;
    const reading = readExpansionSites(
      [expanded.runner as unknown as ResourceManifest],
      [],
      analysis.definitions,
      analysis.aliases,
      analysis.aliasesByModule,
      true,
    );
    const sites = new Map(reading.sites.filter((s) => s.refusal === undefined).map((s) => [s.value, s]));
    // A template instance whose init() expands its body, as the template controller does.
    const context = new ModuleContext(
      "test",
      {},
      {},
      {},
      [],
      async (_ctx, resource) => ({
        resource,
        ctx: {},
        instance: {
          snapshot: async () => ({}),
          init: async () => {
            expandTemplateInstance({
              resource: live(consumer, manifests) as ResourceManifest,
              definition: expanded.runner,
              sites,
              analysis,
              definingContext: { isNeed: () => false } as never,
              consumerContext: { expandWith: () => undefined } as never,
              referenceSitesOf: () => [],
              stampDeclaringModule: (entry) => entry,
            });
          },
        },
      }),
      async () => {},
    );
    context.registerManifest({ kind: "Test.Thing", metadata: { name: "instance" } } as ResourceManifest);
    const error: any = await context.initializeResources().then(
      () => undefined,
      (err) => err,
    );

    expect(error.code).toBe("ERR_RESOURCE_INITIALIZATION_FAILED");
    expect(error.message.split("\n")[0]).toBe("1 resource failed to initialize:");
    // Each refusal is a root cause of its own, worded as `telo check` words it, under its code.
    for (const d of consumers.diagnostics) expect(error.message).toContain(`${d.message} [${d.code}]`);
  });

  it("names an emitted inline declaration alike in the analysis and in the kernel, whatever else the collection holds", async () => {
    const { manifests, analysis, consumers } = await load("callers.yaml");
    const receiver = [...consumers.expansions].find(([c]) => c.metadata.name === "receiver")!;
    const [consumer, expanded] = receiver;
    const sitesOf = (runner: unknown) => {
      const reading = readExpansionSites([runner as ResourceManifest], [], analysis.definitions, analysis.aliases, analysis.aliasesByModule, true);
      return new Map(reading.sites.filter((s) => s.refusal === undefined).map((s) => [s.value, s]));
    };
    const registry = new AnalysisRegistry();
    const kernelNames = (resource: ResourceManifest) => {
      const expansion = expandTemplateInstance({
        resource: live(resource, manifests) as ResourceManifest,
        definition: expanded.runner,
        sites: sitesOf(expanded.runner),
        analysis,
        definingContext: { isNeed: () => false } as never,
        consumerContext: {} as never,
        referenceSitesOf: (entry) => analysis.definitions.referenceSites(entry, analysis.aliases, analysis.aliasesByModule, entry),
        stampDeclaringModule: (entry) => entry,
      });
      return ((expansion.definition as any).resources as any[])
        .map((e) => e.metadata?.name as string)
        .filter((n) => n.includes("handler"));

    };
    void registry;
    const before = kernelNames(consumer);
    expect(before.length).toBe(2);
    // The analysis names the same declarations the same way.
    const [normalized] = normalizeInlineResources(
      [expanded.expansion.definition],
      analysis.definitions,
      analysis.aliases,
      analysis.aliasesByModule,
      (_definition, entry, keys) => emittedInlineName(expanded.expansion, ["resources", entry, ...keys]),
    );
    const analyzerNames = ((normalized as any).resources as any[])
      .filter((e) => e.metadata?.xTeloOrigin)
      .map((e) => e.metadata.name as string);
    expect([...analyzerNames].sort()).toEqual([...before].sort());
    // A hook added before the others moves nothing of the names already given.
    const widened = {
      ...consumer,
      hooks: { alpha: (consumer as any).hooks.github, ...(consumer as any).hooks },
    } as ResourceManifest;
    const after = kernelNames(widened);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(after.length).toBe(3);
  });
});
