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

  it("tells a consumer the bare registry form was removed and what replaces it", async () => {
    // The failing line is frequently inside a dependency the consumer cannot
    // edit, and no migration can rewrite it (the OCI host is not derivable), so
    // the message is the entire remedy available to them.
    const loader = new Loader([
      inMemorySource({ "/ws/telo.yaml": appWithImport("Console", "std/console@0.9.0") }),
    ]);
    const graph = await loader.loadGraph("/ws/telo.yaml");

    const d = importResolutionDiagnostics(graph)[0];
    expect(d.code).toBe("INVALID_IMPORT_SOURCE");
    expect(d.message).toContain("was removed");
    expect(d.message).toContain("oci://");
  });

  it("does not blame the removed form for a source that never resembled it", async () => {
    const loader = new Loader([
      inMemorySource({ "/ws/telo.yaml": appWithImport("Console", "not-found@whatever") }),
    ]);
    const graph = await loader.loadGraph("/ws/telo.yaml");

    expect(importResolutionDiagnostics(graph)[0].message).not.toContain("was removed");
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

  it("codes a target that is not an importable library as INVALID_IMPORT_TARGET", async () => {
    const loader = new Loader([
      inMemorySource({
        "/ws/telo.yaml": appWithImport("Other", "./other"),
        "/ws/other/telo.yaml": [
          "kind: Telo.Application",
          "metadata:",
          "  name: other",
          "  version: 1.0.0",
          "",
        ].join("\n"),
      }),
    ]);
    const graph = await loader.loadGraph("/ws/telo.yaml");

    const diags = importResolutionDiagnostics(graph);
    expect(diags).toHaveLength(1);
    // NOT "cannot resolve": the target was fetched, so telling the author to
    // fix the ref would point at the wrong thing.
    expect(diags[0].code).toBe("INVALID_IMPORT_TARGET");
    expect(diags[0].message).toContain("Cannot use import 'Other'");
    expect(diags[0].message).toContain("Only Telo.Library modules may be imported");
    expect(diags[0].data).toMatchObject({ filePath: "/ws/telo.yaml", path: "imports.Other" });
  });

  it("reports a library that names no module, rather than letting the alias resolve to nothing", async () => {
    const loader = new Loader([
      inMemorySource({
        "/ws/telo.yaml": appWithImport("Lib", "./lib"),
        "/ws/lib/telo.yaml": ["kind: Telo.Library", "metadata:", "  version: 1.0.0", ""].join("\n"),
      }),
    ]);
    const graph = await loader.loadGraph("/ws/telo.yaml");

    const diags = importResolutionDiagnostics(graph);
    expect(diags).toHaveLength(1);
    expect(diags[0].code).toBe("INVALID_IMPORT_TARGET");
    expect(diags[0].message).toContain("declares no 'metadata.name'");
    // No edge, so nothing downstream can resolve `Lib.*` to an invented module.
    expect(graph.importEdges.get("/ws/telo.yaml")?.get("Lib")).toBeUndefined();
  });
});
