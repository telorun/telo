import type { CompiledValue, ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** In-memory ManifestSource backed by a flat path → text map. */
function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports() {
      return true;
    },
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative(base: string, relative: string): string {
      if (relative.startsWith("/")) return relative;
      const baseDir = base.slice(0, base.lastIndexOf("/") + 1);
      return baseDir + relative;
    },
  };
}

const PARTIAL = [
  "kind: Run.Value",
  "metadata:",
  "  name: label",
  "value: !cel \"Billing.format(1)\"",
].join("\n");

function appText(name: string, aliases: string[]): string {
  return [
    "kind: Telo.Application",
    "metadata:",
    `  name: ${name}`,
    "include: [part.yaml]",
    "imports:",
    ...aliases.map((alias) => `  ${alias}: ./${alias.toLowerCase()}`),
  ].join("\n");
}

/** The compiled `value:` of the partial's single document. */
async function compiledPartial(dir: string, files: Record<string, string>): Promise<CompiledValue> {
  const loader = new Loader([inMemorySource(files)]);
  const loaded = await loader.loadModule(`${dir}/telo.yaml`, { compile: true });
  const partial = loaded.partials[0]!.manifests[0] as unknown as { value: CompiledValue };
  return partial.value;
}

describe("a partial compiles with its including module's names", () => {
  it("resolves a call through the owner's import alias", async () => {
    const value = await compiledPartial("/a", {
      "/a/telo.yaml": appText("Checkout", ["Billing"]),
      "/a/part.yaml": PARTIAL,
    });
    expect(value.calls).toEqual(["Billing.format"]);
  });

  it("keeps two modules' compilations of one text apart", async () => {
    // Same file, two owners: one imports `Billing`, the other does not. The
    // parse cache is keyed on the inherited names, so the second owner does not
    // receive the first's program.
    const files = {
      "/a/telo.yaml": appText("Checkout", ["Billing"]),
      "/a/part.yaml": PARTIAL,
      "/b/telo.yaml": appText("Invoicing", ["Ledger"]),
      "/b/part.yaml": PARTIAL,
    };
    const loader = new Loader([inMemorySource(files)]);
    const read = async (dir: string) => {
      const loaded = await loader.loadModule(`${dir}/telo.yaml`, { compile: true });
      return (loaded.partials[0]!.manifests[0] as unknown as { value: CompiledValue }).value;
    };
    expect((await read("/a")).calls).toEqual(["Billing.format"]);
    expect((await read("/b")).calls).toEqual([]);
  });
});

describe("what the analyzer makes of a module call", () => {
  const def = {
    kind: "Telo.Definition",
    metadata: { name: "Value", source: "telo.yaml" },
    capability: "Telo.Runnable",
    schema: {
      type: "object",
      properties: {
        value: { type: "string", "x-telo-eval": "runtime" },
        bindings: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
    controllers: ["pkg:npm/x@1#Value"],
  };

  function analyze(resource: Record<string, unknown>, extra: unknown[] = []): string[] {
    const manifests = [
      {
        kind: "Telo.Application",
        metadata: { name: "Checkout", source: "telo.yaml" },
      },
      {
        kind: "Telo.Import",
        // What flattening stamps: the imported library declares nothing, so a
        // call through it is unresolved rather than undecidable.
        metadata: {
          name: "Billing",
          source: "telo.yaml",
          resolvedModuleName: "billing",
          declaredResources: [],
        },
        source: "../billing",
      },
      { ...def, metadata: { ...def.metadata, module: "lib" } },
      ...extra,
      resource,
    ] as unknown as ResourceManifest[];
    return new StaticAnalyzer()
      .analyze(withSyntheticPositions(manifests))
      .map((d) => `${d.code}`);
  }

  const value = (source: string) => ({
    kind: "lib.Value",
    metadata: { name: "label", source: "telo.yaml" },
    value: { __tagged: true, engine: "cel", source },
  });

  // Nothing here declares a callable, so a module call is FUNCTION_UNRESOLVED;
  // what these pin is that it gets THAT and not the catalog's refusal of an
  // unknown method on an undeclared receiver.
  it("reads an import alias as a module, not as an unknown identifier", () => {
    expect(analyze(value("Billing.format(1)"))).toEqual(["FUNCTION_UNRESOLVED"]);
  });

  it("resolves the module's own name like Self", () => {
    expect(analyze(value("Checkout.withVat(1) + Self.x(2)"))).toEqual([
      "FUNCTION_UNRESOLVED",
      "FUNCTION_UNRESOLVED",
    ]);
  });

  it("reports one unresolved call per qualified name, not per occurrence", () => {
    expect(analyze(value("Billing.format(1) + Billing.format(2)"))).toEqual([
      "FUNCTION_UNRESOLVED",
    ]);
  });

  it("still reports a receiver that names no module", () => {
    expect(analyze(value("Ledger.format(1)"))).toContain("CEL_UNKNOWN_IDENTIFIER");
  });
});

describe("a module's own name is an alias beside Self", () => {
  it("registers it in the root table and in each library's", () => {
    const registry = new AnalysisRegistry();
    const manifests = [
      { kind: "Telo.Application", metadata: { name: "Checkout", source: "telo.yaml" } },
      {
        kind: "Telo.Definition",
        metadata: { name: "Value", source: "telo.yaml", module: "lib" },
        capability: "Telo.Runnable",
        schema: { type: "object" },
        controllers: ["pkg:npm/x@1#Value"],
      },
    ] as unknown as ResourceManifest[];
    new StaticAnalyzer().analyze(withSyntheticPositions(manifests), undefined, registry);

    const ctx = registry._context();
    expect(ctx.aliases!.resolveKind("Checkout.Thing")).toBe("Checkout.Thing");
    expect(ctx.aliasesByModule!.get("lib")!.resolveKind("lib.Value")).toBe(
      ctx.aliasesByModule!.get("lib")!.resolveKind("Self.Value"),
    );
  });
});

describe("names a module call takes over", () => {
  const bindingsDef = {
    kind: "Telo.Definition",
    metadata: { name: "Choice", source: "telo.yaml", module: "lib" },
    capability: "Telo.Runnable",
    schema: {
      type: "object",
      properties: {
        bindings: { type: "object", additionalProperties: true },
        value: {
          type: "string",
          "x-telo-eval": "runtime",
          "x-telo-context": {
            type: "object",
            "x-telo-bindings-from": "bindings",
            properties: {},
          },
        },
      },
    },
    controllers: ["pkg:npm/x@1#Choice"],
  };

  function analyze(bindings: Record<string, unknown>): string[] {
    const manifests = [
      { kind: "Telo.Application", metadata: { name: "Checkout", source: "telo.yaml" } },
      {
        kind: "Telo.Import",
        metadata: { name: "Billing", source: "telo.yaml", resolvedModuleName: "billing" },
        source: "../billing",
      },
      bindingsDef,
      {
        kind: "lib.Choice",
        metadata: { name: "choice", source: "telo.yaml" },
        bindings,
        value: { __tagged: true, engine: "cel", source: "'x'" },
      },
    ] as unknown as ResourceManifest[];
    return new StaticAnalyzer()
      .analyze(withSyntheticPositions(manifests))
      .filter((d) => d.code === "BINDING_NAME_RESERVED")
      .map((d) => d.message);
  }

  it("reserves a bindings key equal to the module's own name", () => {
    expect(analyze({ Checkout: { __tagged: true, engine: "cel", source: "1" } })[0]).toContain(
      "names a module here",
    );
  });

  it("reserves a bindings key equal to an import alias", () => {
    expect(analyze({ Billing: { __tagged: true, engine: "cel", source: "1" } })).toHaveLength(1);
  });
});

describe("an import alias a kind already put in CEL scope", () => {
  it("reports at the imports: key", () => {
    const manifests = [
      { kind: "Telo.Application", metadata: { name: "Checkout", source: "telo.yaml" } },
      {
        kind: "Telo.Import",
        metadata: { name: "Request", source: "telo.yaml", resolvedModuleName: "req" },
        source: "../req",
      },
      {
        kind: "Telo.Definition",
        metadata: { name: "Route", source: "telo.yaml", module: "lib" },
        capability: "Telo.Invocable",
        schema: {
          type: "object",
          properties: {
            handler: {
              type: "string",
              "x-telo-eval": "runtime",
              "x-telo-context": {
                type: "object",
                properties: { Request: { type: "object" } },
              },
            },
          },
        },
        controllers: ["pkg:npm/x@1#Route"],
      },
      {
        kind: "lib.Route",
        metadata: { name: "route", source: "telo.yaml" },
        handler: { __tagged: true, engine: "cel", source: "'x'" },
      },
    ] as unknown as ResourceManifest[];

    const reported = new StaticAnalyzer()
      .analyze(withSyntheticPositions(manifests))
      .filter((d) => d.code === "IMPORT_ALIAS_SHADOWS_CONTEXT");
    expect(reported).toHaveLength(1);
    expect((reported[0]!.data as { resource?: { kind?: string; name?: string } }).resource).toEqual({
      kind: "Telo.Import",
      name: "Request",
    });
  });
});
