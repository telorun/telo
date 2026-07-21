import {
  DiagnosticSeverity,
  Loader,
  type AnalysisDiagnostic,
  type ManifestSource,
} from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { assembleGraphDiagnostics } from "../src/diagnostics/graph-diagnostics.js";

/** In-memory ManifestSource — supports everything, reads from a path→text map,
 *  and resolves relatives to `<dir>/<name>/telo.yaml`. */
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
      const parts = (baseDir + relative).split("/");
      const out: string[] = [];
      for (const p of parts) {
        if (p === "" && out.length === 0) {
          out.push("");
          continue;
        }
        if (p === "" || p === ".") continue;
        if (p === "..") {
          if (out.length > 1) out.pop();
          continue;
        }
        out.push(p);
      }
      let resolved = out.join("/");
      if (!/\.[^/]+$/.test(resolved)) resolved += "/telo.yaml";
      return resolved;
    },
  };
}

function appWithImport(alias: string, source: string): string {
  return [
    "kind: Telo.Application",
    "metadata:",
    "  name: app",
    "  version: 1.0.0",
    "---",
    "kind: Telo.Import",
    "metadata:",
    `  name: ${alias}`,
    `source: ${source}`,
    "",
  ].join("\n");
}

/** An app with no imports — nothing to compromise it, so only files added to
 *  the compromised set explicitly (e.g. a pushed parse diagnostic) are held back. */
function appNoImport(): string {
  return ["kind: Telo.Application", "metadata:", "  name: app", "  version: 1.0.0", ""].join("\n");
}

describe("assembleGraphDiagnostics", () => {
  it("folds import-resolution errors in alongside live analysis output", async () => {
    const loader = new Loader([
      inMemorySource({ "/ws/telo.yaml": appWithImport("Console", "not-found@whatever") }),
    ]);
    const graph = await loader.loadGraph("/ws/telo.yaml");

    // A healthy analysis diagnostic (not on the compromised importer file).
    const analysis: AnalysisDiagnostic[] = [
      {
        severity: DiagnosticSeverity.Error,
        code: "SOME_ANALYSIS",
        message: "x",
        data: { filePath: "/ws/other.yaml" },
      },
    ];
    const { diagnostics, suppressed } = assembleGraphDiagnostics(graph, analysis);

    expect(diagnostics.some((d) => d.code === "INVALID_IMPORT_SOURCE")).toBe(true);
    expect(diagnostics.some((d) => d.code === "SOME_ANALYSIS")).toBe(true);
    expect(suppressed).toHaveLength(0);
  });

  it("suppresses the analysis cascade for a file whose import failed to resolve", async () => {
    const loader = new Loader([
      inMemorySource({ "/ws/telo.yaml": appWithImport("Console", "not-found@whatever") }),
    ]);
    const graph = await loader.loadGraph("/ws/telo.yaml");

    const analysis: AnalysisDiagnostic[] = [
      // Cascade on the importer file — must be held back in `suppressed`.
      { severity: DiagnosticSeverity.Error, code: "UNDEFINED_KIND", message: "Console.X", data: { filePath: "/ws/telo.yaml" } },
      // A defect on a healthy file — must survive.
      { severity: DiagnosticSeverity.Error, code: "REAL", message: "real", data: { filePath: "/ws/other.yaml" } },
    ];
    const { diagnostics, suppressed } = assembleGraphDiagnostics(graph, analysis);

    // The coded import error is always surfaced.
    expect(diagnostics.some((d) => d.code === "INVALID_IMPORT_SOURCE")).toBe(true);
    // The cascade is held back, not surfaced.
    expect(diagnostics.some((d) => d.code === "UNDEFINED_KIND")).toBe(false);
    expect(suppressed.some((d) => d.code === "UNDEFINED_KIND")).toBe(true);
    // The healthy defect survives.
    expect(diagnostics.some((d) => d.code === "REAL")).toBe(true);
  });

  it("suppresses the analysis cascade for a file that failed to parse", async () => {
    const loader = new Loader([inMemorySource({ "/ws/telo.yaml": appNoImport() })]);
    const graph = await loader.loadGraph("/ws/telo.yaml");
    // Simulate a parse failure on a sibling file.
    graph.parseDiagnostics.push({
      severity: DiagnosticSeverity.Error,
      code: "MANIFEST_PARSE_FAILED",
      message: "boom",
      data: { filePath: "/ws/broken.yaml" },
    });

    const analysis: AnalysisDiagnostic[] = [
      { severity: DiagnosticSeverity.Error, code: "CASCADE", message: "spurious", data: { filePath: "/ws/broken.yaml" } },
      { severity: DiagnosticSeverity.Error, code: "REAL", message: "real", data: { filePath: "/ws/telo.yaml" } },
    ];
    const { diagnostics, suppressed } = assembleGraphDiagnostics(graph, analysis);

    expect(diagnostics.some((d) => d.code === "CASCADE")).toBe(false);
    expect(suppressed.some((d) => d.code === "CASCADE")).toBe(true);
    expect(diagnostics.some((d) => d.code === "REAL")).toBe(true);
    // The parse diagnostic itself is retained in the surfaced set.
    expect(diagnostics.some((d) => d.code === "MANIFEST_PARSE_FAILED")).toBe(true);
  });
});
