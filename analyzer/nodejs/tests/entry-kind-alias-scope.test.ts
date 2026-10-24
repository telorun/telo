import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * An entry module's resource names its kind through the entry's own aliases,
 * as the kernel resolves it. A module that only a dependency imports is loaded
 * into the graph, and its definitions are registered under its canonical name —
 * which must not make `<ThatModule>.<Kind>` resolve in the entry, or `telo check`
 * passes a manifest that fails at boot with "no module imported with alias".
 */

const app = (imports: ResourceManifest[]): ResourceManifest[] => [
  { kind: "Telo.Application", metadata: { name: "App", source: "app.yaml" } } as unknown as ResourceManifest,
  ...imports,
];

const importOf = (alias: string, module: string, from?: string): ResourceManifest =>
  ({
    kind: "Telo.Import",
    metadata: {
      name: alias,
      resolvedModuleName: module,
      source: from ? `${from}/telo.yaml` : "app.yaml",
      ...(from ? { module: from } : {}),
    },
    source: `./${module}`,
  }) as unknown as ResourceManifest;

const connectionKind = {
  kind: "Telo.Definition",
  metadata: { name: "Connection", module: "SQLite", source: "sqlite/telo.yaml" },
  capability: "Telo.Provider",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

const declare = (kind: string): ResourceManifest =>
  ({ kind, metadata: { name: "db", source: "app.yaml" } }) as unknown as ResourceManifest;

function undefinedKinds(docs: ResourceManifest[]) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(docs))
    .filter((d) => d.code === "UNDEFINED_KIND")
    .map((d) => ({ message: d.message, fix: (d.data as { fix?: unknown } | undefined)?.fix }));
}

describe("a kind spelled by the name of a module the entry does not import", () => {
  it("is refused when only a dependency imports that module", () => {
    const found = undefinedKinds([
      ...app([importOf("Lib", "Lib"), importOf("SQLite", "SQLite", "Lib")]),
      connectionKind,
      declare("SQLite.Connection"),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("no module imported with alias 'SQLite' in this module");
    expect(found[0]!.message).toContain("add it to this module's 'imports:'");
    expect(found[0]!.fix).toBeUndefined();
  });

  it("names the alias the entry imports the module under, as the repair", () => {
    const found = undefinedKinds([
      ...app([importOf("Db", "SQLite")]),
      connectionKind,
      declare("SQLite.Connection"),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("This module imports it as 'Db' — write 'Db.Connection'.");
    expect(found[0]!.fix).toEqual({ replacement: "Db.Connection" });
  });

  it("resolves through the entry's own alias", () => {
    expect(
      undefinedKinds([...app([importOf("Db", "SQLite")]), connectionKind, declare("Db.Connection")]),
    ).toEqual([]);
  });

  it("is not resolved through another module when the entry's alias names one lacking the kind", () => {
    const found = undefinedKinds([
      ...app([importOf("SQLite", "Own"), importOf("Lib", "Lib"), importOf("Real", "SQLite", "Lib")]),
      connectionKind,
      declare("SQLite.Connection"),
    ]);
    expect(found.map((d) => d.message)).toEqual(["No Telo.Definition found for kind 'SQLite.Connection'."]);
  });
});
