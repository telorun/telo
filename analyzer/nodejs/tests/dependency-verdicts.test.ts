import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeDependencies,
  analyzeLoadedGraph,
  assembleGraphDiagnostics,
  collectApplicationSources,
  collectModuleDocuments,
  dependencyVerdictKey,
  DependencyVerdictMemo,
  DiagnosticSeverity,
  flattenForAnalyzer,
  Loader,
  locateDiagnostic,
  moduleOrigins,
  StaticAnalyzer,
  unionDiagnostics,
  type AnalysisDiagnostic,
  type DependencyVerdict,
  type DependencyVerdictStore,
  type LoadedGraph,
  type ManifestSource,
} from "../src/index.js";
import { ROOT } from "./configuration-corpus.js";

/**
 * The dependency stage: each library an application loads is judged by its own
 * entry analysis, reported by its origin — an editable library at its own
 * lines, an artifact's errors as warnings at the entry's import reaching it.
 */
const FIXTURES = join(ROOT, "analyzer/nodejs/tests/__fixtures__/dependency-verdicts");
const SCREENS = join(FIXTURES, "screens/telo.yaml");
const PUBLISHED = "oci://registry.test/screens@1.0.0";

/** What each published ref serves: a cached file copy of its manifest. */
const REGISTRY = new Map([
  [PUBLISHED, SCREENS],
  ["oci://registry.test/legacy@1.0.0", SCREENS],
  ["oci://registry.test/tidy@1.0.0", join(FIXTURES, "lowercase/telo.yaml")],
  ["oci://registry.test/capability@1.0.0", join(FIXTURES, "capability/telo.yaml")],
  ["oci://registry.test/store@1.0.0", join(FIXTURES, "registry/store-1.0.0/telo.yaml")],
  ["oci://registry.test/store@1.1.0", join(FIXTURES, "registry/store-1.1.0/telo.yaml")],
]);

/** Reads fixtures from disk, `overrides` first, and published refs from
 *  {@link REGISTRY}. */
function fixtureSource(
  overrides: ReadonlyMap<string, string> = new Map(),
  entries?: () => "file" | "directory",
): ManifestSource {
  const fileOf = (url: string) =>
    REGISTRY.get(url) ?? (existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url);
  return {
    supports: () => true,
    async read(url) {
      const file = fileOf(url);
      return { text: overrides.get(file) ?? readFileSync(file, "utf8"), source: file };
    },
    resolveRelative: (base, relative) => (relative.startsWith("oci://") ? relative : resolve(dirname(base), relative)),
    ...(entries ? { entryAt: async () => entries() } : {}),
  };
}

async function load(
  file: string,
  overrides?: ReadonlyMap<string, string>,
  entries?: () => "file" | "directory",
): Promise<LoadedGraph> {
  return new Loader([fixtureSource(overrides, entries)]).loadGraph(join(FIXTURES, file), { desugarImports: true });
}

/** `telo check <entry>` as it reported before the dependency stage. */
function entryAlone(graph: LoadedGraph): AnalysisDiagnostic[] {
  const analysis = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
    moduleDocuments: collectModuleDocuments(graph),
    applicationSources: collectApplicationSources(graph),
  });
  return assembleGraphDiagnostics(graph, analysis).diagnostics;
}

const summary = (d: AnalysisDiagnostic) => {
  const data = d.data as { filePath?: string; path?: string } | undefined;
  return { code: d.code, severity: d.severity, file: data?.filePath, path: data?.path, message: d.message };
};

class CountingAnalyzer extends StaticAnalyzer {
  calls = 0;
  override analyze(...args: Parameters<StaticAnalyzer["analyze"]>): ReturnType<StaticAnalyzer["analyze"]> {
    this.calls++;
    return super.analyze(...args);
  }
}

describe("dependency verdicts", () => {
  it("reports an editable library's findings at its own lines, as its own check does", async () => {
    const graph = await load("editable.yaml");
    const { diagnostics } = await analyzeDependencies(graph, { memo: new DependencyVerdictMemo() });
    const library = await load("screens/telo.yaml");
    const own = entryAlone(library);

    const violation = diagnostics.find((d) => d.code === "SCHEMA_VIOLATION");
    expect(violation).toBeDefined();
    expect(violation!.severity).toBe(DiagnosticSeverity.Error);
    expect(summary(violation!)).toEqual(summary(own.find((d) => d.code === "SCHEMA_VIOLATION")!));
    expect(locateDiagnostic(graph, violation!)).toEqual(locateDiagnostic(library, violation!));
    expect(locateDiagnostic(graph, violation!)?.file).toBe(SCREENS);
  }, 120_000);

  it("reports an editable library's warnings", async () => {
    const graph = await load("editable.yaml");
    const { diagnostics } = await analyzeDependencies(graph, { memo: new DependencyVerdictMemo() });
    const notes = diagnostics.filter((d) => (d.data as { filePath?: string }).filePath === join(FIXTURES, "notes/telo.yaml"));
    expect(notes.map((d) => [d.code, d.severity])).toEqual([["NAME_CASE_CONVENTION", DiagnosticSeverity.Warning]]);
  }, 120_000);

  it("reports a published library's errors alone, as warnings at the import reaching it", async () => {
    const graph = await load("artifact.yaml");
    expect(moduleOrigins(graph).get(SCREENS)).toBe("artifact");
    const { diagnostics, verdicts } = await analyzeDependencies(graph, { memo: new DependencyVerdictMemo() });
    expect(verdicts[0]!.verdict.diagnostics.map((d) => d.code).sort()).toEqual([
      "NAME_CASE_CONVENTION",
      "SCHEMA_VIOLATION",
    ]);
    expect(diagnostics.map(summary)).toEqual([
      {
        code: "SCHEMA_VIOLATION",
        severity: DiagnosticSeverity.Warning,
        file: join(FIXTURES, "artifact.yaml"),
        path: "imports.Screens",
        message: expect.stringMatching(/^Imported library 'Screens', reached through import 'Screens': /),
      },
    ]);
  }, 120_000);

  it("warns, never refuses, for a published library's own naming defect", async () => {
    const result = await analyzeLoadedGraph(await load("lowercase-artifact.yaml"), { memo: new DependencyVerdictMemo() });
    expect(result.diagnostics.map(summary)).toEqual([
      {
        code: "INVALID_TYPE_NAME",
        severity: DiagnosticSeverity.Warning,
        file: join(FIXTURES, "lowercase-artifact.yaml"),
        path: "imports.Tidy",
        message: expect.stringMatching(/^Imported library 'tidy', reached through import 'Tidy': /),
      },
    ]);
    expect(result.errors).toEqual([]);
  }, 120_000);

  it("keeps the entry's refusal at an import an error, not duplicated by the published library's warning", async () => {
    const result = await analyzeLoadedGraph(await load("capability-artifact.yaml"), { memo: new DependencyVerdictMemo() });
    const found = result.diagnostics.filter((d) => d.code === "CAPABILITY_UNKNOWN");
    expect(found.map(summary)).toEqual([
      expect.objectContaining({ severity: DiagnosticSeverity.Error, path: "imports.Capability" }),
    ]);
    expect(result.errors).toEqual(found);
  }, 120_000);

  it("treats a library reached through a published import as published, however it is reached", async () => {
    const graph = await load("transitive.yaml");
    const origins = moduleOrigins(graph);
    expect(origins.get(join(FIXTURES, "wrapper/telo.yaml"))).toBe("editable");
    expect(origins.get(SCREENS)).toBe("artifact");
    const { diagnostics } = await analyzeDependencies(graph, { memo: new DependencyVerdictMemo() });
    expect(diagnostics.map(summary)).toEqual([
      {
        code: "SCHEMA_VIOLATION",
        severity: DiagnosticSeverity.Warning,
        file: join(FIXTURES, "transitive.yaml"),
        path: "imports.Wrapper",
        message: expect.stringMatching(/^Imported library 'Screens', reached through import 'Wrapper': /),
      },
    ]);
  }, 120_000);

  it("judges no library only a version reconciliation replaced reaches", async () => {
    const graph = await load("reconciled.yaml");
    const { diagnostics, verdicts } = await analyzeDependencies(graph, { memo: new DependencyVerdictMemo() });
    expect(verdicts.map((v) => [v.module, v.source, v.origin])).toEqual([
      ["Store", join(FIXTURES, "registry/store-1.1.0/telo.yaml"), "artifact"],
      ["Old", join(FIXTURES, "old/telo.yaml"), "editable"],
    ]);
    expect(diagnostics).toEqual([]);
  }, 120_000);

  it("judges a closure once, and again when one of its files changes", async () => {
    const kept = new Map<string, DependencyVerdict>();
    let sets = 0;
    const store: DependencyVerdictStore = {
      get: async (key) => kept.get(key),
      set: async (key, verdict) => {
        sets++;
        kept.set(key, verdict);
      },
    };
    const analyzer = new CountingAnalyzer();
    const memo = new DependencyVerdictMemo();
    const graph = await load("artifact.yaml");
    const first = await analyzeDependencies(graph, { analyzer, memo, store });
    expect([analyzer.calls, sets]).toEqual([1, 1]);

    // In process, and through the store from a fresh process.
    const again = await analyzeDependencies(await load("artifact.yaml"), { analyzer, memo, store });
    const restored = await analyzeDependencies(await load("artifact.yaml"), {
      analyzer,
      memo: new DependencyVerdictMemo(),
      store,
    });
    expect([analyzer.calls, sets]).toEqual([1, 1]);
    expect(again.diagnostics).toEqual(first.diagnostics);
    expect(restored.diagnostics).toEqual(first.diagnostics);

    const edited = await load(
      "artifact.yaml",
      new Map([[SCREENS, readFileSync(SCREENS, "utf8").replace("size: big", "size: 2")]]),
    );
    expect(await dependencyVerdictKey(edited, SCREENS)).not.toBe(await dependencyVerdictKey(graph, SCREENS));
    const fixed = await analyzeDependencies(edited, { analyzer, memo, store });
    expect([analyzer.calls, sets]).toEqual([2, 2]);
    expect(fixed.diagnostics).toEqual([]);
  }, 120_000);

  it("reports a finding only where an import reaches its configuration", async () => {
    const codes = async (file: string) =>
      (await analyzeDependencies(await load(file), { memo: new DependencyVerdictMemo() })).diagnostics.map((d) => [
        d.code,
        (d.data as { configurations?: unknown }).configurations,
      ]);
    expect(await codes("mode-a.yaml")).toEqual([]);
    expect(await codes("mode-b.yaml")).toEqual([["SCHEMA_VIOLATION", [{ "variables.mode": "b" }]]]);
  }, 120_000);

  it("reports a defect the entry also finds at its import once, where the library's own check does", async () => {
    const graph = await load("capability-app.yaml");
    expect(entryAlone(graph).map(summary)).toEqual([
      expect.objectContaining({ code: "CAPABILITY_UNKNOWN", path: "imports.Capability" }),
    ]);
    const { diagnostics } = await analyzeLoadedGraph(graph, { memo: new DependencyVerdictMemo() });
    expect(diagnostics.map(summary)).toEqual([
      expect.objectContaining({ code: "CAPABILITY_UNKNOWN", file: join(FIXTURES, "capability/telo.yaml"), path: "capability" }),
    ]);
  }, 120_000);

  it("unions diagnostics of several analyses by identity", async () => {
    const app = await analyzeLoadedGraph(await load("editable.yaml"), { memo: new DependencyVerdictMemo() });
    const library = entryAlone(await load("screens/telo.yaml"));
    const union = unionDiagnostics(app.diagnostics, library);
    expect(union).toEqual(app.diagnostics);
    expect(union.filter((d) => d.code === "SCHEMA_VIOLATION")).toHaveLength(1);
  }, 120_000);

  it("leaves a library's own check unchanged when it loads nothing", async () => {
    const graph = await load("screens/telo.yaml");
    const before = entryAlone(graph);
    const after = await analyzeLoadedGraph(graph, { memo: new DependencyVerdictMemo() });
    expect(after.diagnostics).toEqual(before);
    expect(after.errors).toEqual(before.filter((d) => d.severity === DiagnosticSeverity.Error));
  }, 120_000);

  it("reports a defect deep in a chain of imports once", async () => {
    const { diagnostics } = await analyzeLoadedGraph(await load("chain.yaml"), { memo: new DependencyVerdictMemo() });
    expect(diagnostics.map(summary)).toEqual([
      expect.objectContaining({ code: "CAPABILITY_UNKNOWN", file: join(FIXTURES, "capability/telo.yaml") }),
    ]);
  }, 120_000);

  it("reports a child application a library runs, as the library's own check does", async () => {
    const graph = await load("child-app.yaml");
    expect(entryAlone(graph)).toEqual([]);
    const { diagnostics } = await analyzeLoadedGraph(graph, { memo: new DependencyVerdictMemo() });
    expect(diagnostics.map(summary)).toEqual([
      expect.objectContaining({ code: "APPLICATION_INPUT_UNDECLARED", file: join(FIXTURES, "childapp/telo.yaml") }),
    ]);
  }, 120_000);

  it("keys a verdict by what the loader found at a file claim", async () => {
    const CLAIMS = join(FIXTURES, "claims/telo.yaml");
    const keyOf = async (entry: "file" | "directory") => dependencyVerdictKey(await load("claims.yaml", undefined, () => entry), CLAIMS);
    expect(await keyOf("file")).not.toBe(await keyOf("directory"));
    expect(await keyOf("file")).toBe(await keyOf("file"));
  }, 120_000);

  it("keeps verdicts apart for analyzers holding different CEL handlers", async () => {
    const graph = await load("artifact.yaml");
    const first = new CountingAnalyzer({ celHandlers: {} });
    const second = new CountingAnalyzer({ celHandlers: {} });
    await analyzeDependencies(graph, { analyzer: first });
    await analyzeDependencies(graph, { analyzer: second });
    expect([first.calls, second.calls]).toEqual([1, 1]);
  }, 120_000);
});
