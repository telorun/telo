import { describe, expect, it } from "vitest";
import { importResolutionDiagnostics } from "../src/import-resolution-diagnostics.js";
import { Loader } from "../src/manifest-loader.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";

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

describe("importResolutionDiagnostics", () => {
  it("codes a malformed import source as INVALID_IMPORT_SOURCE, anchored at the alias", async () => {
    const loader = new Loader([
      inMemorySource({ "/ws/telo.yaml": appWithImport("Console", "not-found@whatever") }),
    ]);
    const graph = await loader.loadGraph("/ws/telo.yaml");

    const diags = importResolutionDiagnostics(graph);
    expect(diags).toHaveLength(1);
    const d = diags[0];
    expect(d.code).toBe("INVALID_IMPORT_SOURCE");
    expect(d.severity).toBe(DiagnosticSeverity.Error);
    // Quotes what the author wrote, names the alias, actionable.
    expect(d.message).toContain("not-found@whatever");
    expect(d.message).toContain("Console");
    // Routes to the importer file + the `imports.<alias>` field.
    expect(d.data).toMatchObject({ filePath: "/ws/telo.yaml", path: "imports.Console" });
  });

  it("codes a well-formed but unresolvable source as IMPORT_UNRESOLVED, quoting the author string", async () => {
    // `./nope` is a valid relative-path shape; it just doesn't exist.
    const loader = new Loader([
      inMemorySource({ "/ws/telo.yaml": appWithImport("Lib", "./nope") }),
    ]);
    const graph = await loader.loadGraph("/ws/telo.yaml");

    const diags = importResolutionDiagnostics(graph);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("IMPORT_UNRESOLVED");
    // Quotes the author's `./nope` as the unresolved ref (the underlying error
    // detail may still name the resolved path — that's the real cause).
    expect(diags[0].message).toContain("import 'Lib' → './nope'");
  });
});
