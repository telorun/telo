import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeLoadedGraph } from "../src/graph-analysis.js";
import { applyLibraryMigrationRecord } from "../src/library-migrations/edit-record.js";
import { cloneMigrationTree } from "../src/library-migrations/rule-application.js";
import type { LoadedGraph } from "../src/loaded-types.js";
import { migrationMatchHolds, type MigrationMatch } from "../src/library-migrations/match.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";
import { parseManifestDocuments } from "../src/yaml-ast.js";

/** `analyzer/library-migration-conformance/`: the library-migration matcher and
 *  the checks a library's own `telo check` makes of its `migrations:`. */
const ROOT = fileURLToPath(new URL("../../library-migration-conformance/", import.meta.url));
const CHECKS = join(ROOT, "checks");
const CONSUMERS = join(ROOT, "consumers");

const fileSource: ManifestSource = {
  supports: (url) => url.startsWith("file://") || isAbsolute(url),
  async read(url) {
    const path = url.startsWith("file://") ? fileURLToPath(url) : url;
    const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "telo.yaml") : path;
    return { text: readFileSync(file, "utf8"), source: pathToFileURL(file).href };
  },
  resolveRelative: (base, relative) =>
    pathToFileURL(resolve(dirname(base.startsWith("file://") ? fileURLToPath(base) : base), relative)).href,
};

interface MatcherVector {
  id: string;
  value: string;
  match: MigrationMatch;
  holds: boolean;
}

const sortedByText = (items: unknown[]) =>
  [...items].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));

describe("library migration matcher", () => {
  const { vectors } = JSON.parse(readFileSync(join(ROOT, "matcher.json"), "utf8")) as { vectors: MatcherVector[] };
  for (const vector of vectors) {
    it(vector.id, () => {
      const [doc] = parseManifestDocuments(vector.value);
      expect(doc!.errors).toEqual([]);
      expect(migrationMatchHolds(vector.match, doc!.toJSON())).toBe(vector.holds);
    });
  }
});

async function checkRow(dir: string, base = dir) {
  const graph = await new Loader([fileSource]).loadGraph(join(dir, "telo.yaml"), {
    desugarImports: true,
    migrate: true,
  });
  const { diagnostics } = await analyzeLoadedGraph(graph);
  const prefix = `${pathToFileURL(base).href}/`;
  const shown = diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    file: String((d.data as { filePath?: string } | undefined)?.filePath ?? "").split(prefix).join(""),
    path: (d.data as { path?: string } | undefined)?.path,
    message: d.message,
  }));
  return { graph, shown: sortedByText(shown), prefix };
}

describe("library migration checks", () => {
  for (const id of readdirSync(CHECKS)) {
    it(id, async () => {
      const dir = join(CHECKS, id);
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
      const { shown } = await checkRow(dir);
      expect(shown).toEqual(sortedByText(expected.diagnostics));
    });
  }
});

/** A document as the vectors write it: a tagged value as `!<engine> <source>`. */
function written(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && (v as { __tagged?: unknown }).__tagged === true
        ? `!${(v as { engine: string }).engine} ${(v as { source: string }).source}`
        : v,
    ),
  );
}

/** Every rewritten document of `graph`, by file relative to the row, then index. */
function migratedDocuments(graph: LoadedGraph, prefix: string, documentsOf: (file: string) => readonly unknown[]) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const anchor of graph.libraryMigrations?.rewritten ?? []) {
    const file = anchor.file.split(prefix).join("");
    (out[file] ??= {})[String(anchor.document)] = written(documentsOf(anchor.file)[anchor.document]);
  }
  return out;
}

describe("library migrations at a consumer", () => {
  for (const id of readdirSync(CONSUMERS).filter((name) => !name.startsWith("__"))) {
    it(id, async () => {
      const dir = join(CONSUMERS, id);
      const { graph, shown, prefix } = await checkRow(dir, CONSUMERS);
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
      expect(shown).toEqual(sortedByText(expected.diagnostics));
      const filesBySource = new Map(
        [...graph.modules.values()].flatMap((m) => [m.owner, ...m.partials]).map((f) => [f.source, f]),
      );
      expect(migratedDocuments(graph, prefix, (file) => filesBySource.get(file)!.manifests)).toEqual(expected.migrated);
      // The one apply, over fresh copies of the trees as they were before the stage.
      const outcome = graph.libraryMigrations;
      const fresh = new Map(
        [...(outcome?.originals ?? [])].map(([file, docs]) => [file, docs.map(cloneMigrationTree)]),
      );
      for (const record of outcome?.records.values() ?? []) applyLibraryMigrationRecord(record, (file) => fresh.get(file));
      expect(migratedDocuments(graph, prefix, (file) => fresh.get(file)!)).toEqual(expected.migrated);
    });
  }
});
