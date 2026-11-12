import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectApplicationSources } from "../src/child-application.js";
import { locateDiagnostic } from "../src/diagnostic-location.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { assembleGraphDiagnostics } from "../src/graph-diagnostics.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/** `analyzer/check-conformance/`: each row is a manifest tree and what `telo check`
 *  reports for it, every diagnostic whole and at the range it is shown at. */
const VECTORS = fileURLToPath(new URL("../../check-conformance/vectors/", import.meta.url));

/** The filesystem as `telo check` reads it: every source a `file://` URL, a directory
 *  read as its `telo.yaml`. */
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

/** Every string with the row directory's prefix removed, so a file reads relative to it. */
function relativize(value: unknown, prefixes: string[]): unknown {
  if (typeof value === "string") return prefixes.reduce((text, prefix) => text.split(prefix).join(""), value);
  if (Array.isArray(value)) return value.map((item) => relativize(item, prefixes));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relativize(item, prefixes)]));
  }
  return value;
}

/** The canonical sort: by each diagnostic's JSON text with keys sorted at every depth,
 *  compared by code point. */
function sorted(diagnostics: unknown[]): unknown[] {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as any)[key])]))
        : value;
  const text = (value: unknown) => Buffer.from(JSON.stringify(canonical(value)), "utf8");
  return [...diagnostics].sort((a, b) => Buffer.compare(text(a), text(b)));
}

describe("check conformance", () => {
  for (const id of readdirSync(VECTORS)) {
    it(id, async () => {
      const dir = join(VECTORS, id);
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
      expect(Object.keys(expected).sort()).toEqual(["diagnostics", "runFails"]);
      const graph = await new Loader([fileSource]).loadGraph(join(dir, "telo.yaml"), {
        desugarImports: true,
        migrate: true,
      });
      const analysis = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
        moduleDocuments: collectModuleDocuments(graph),
        applicationSources: collectApplicationSources(graph),
        hostVersions: { node: process.versions.node },
      });
      const prefixes = [`${pathToFileURL(dir).href}/`, `${dir}${sep}`];
      const diagnostics = assembleGraphDiagnostics(graph, analysis).diagnostics.map((d) => {
        const located = locateDiagnostic(graph, d);
        const shown = JSON.parse(JSON.stringify(d));
        delete shown.range;
        if (located) shown.range = located.range;
        return relativize(shown, prefixes);
      });
      expect(sorted(diagnostics)).toEqual(sorted(expected.diagnostics));
    });
  }
});
