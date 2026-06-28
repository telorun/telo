import { describe, expect, it } from "vitest";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import type { ManifestSource } from "../src/types.js";

/** In-memory ManifestSource backed by a flat path → text map (mirrors
 *  load-graph-error-sourceline.test.ts). Resolves relative paths and appends
 *  `/telo.yaml` to extensionless targets, like a real directory import. */
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

function lib(namespace: string, name: string, version: string, imports?: Record<string, string>) {
  const lines = [
    "kind: Telo.Library",
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    `  version: ${version}`,
  ];
  if (imports) {
    lines.push("imports:");
    for (const [alias, source] of Object.entries(imports)) lines.push(`  ${alias}: ${source}`);
  }
  return lines.join("\n") + "\n";
}

function loaderFor(files: Record<string, string>): Loader {
  return new Loader([inMemorySource(files)]);
}

describe("reconcileModuleVersions via loadGraph", () => {
  it("hoists a same-major skew to the higher version silently", async () => {
    // app imports std/shared@0.2.0 directly; sub imports std/shared@0.1.0.
    const files: Record<string, string> = {
      "/ws/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: app, version: 1.0.0 }",
        "imports:",
        "  Shared: ./shared-v2",
        "  Sub: ./sub",
      ].join("\n"),
      "/ws/shared-v2/telo.yaml": lib("std", "shared", "0.2.0"),
      "/ws/sub/telo.yaml": lib("std", "sub", "1.0.0", { Old: "./shared-v1" }),
      "/ws/sub/shared-v1/telo.yaml": lib("std", "shared", "0.1.0"),
    };

    const graph = await loaderFor(files).loadGraph("/ws/telo.yaml", { desugarImports: true });

    // Additive pre-1.0 hoist: redirect happens, but no diagnostic is emitted.
    expect(graph.versionDiagnostics).toHaveLength(0);

    // Loser (0.1.0) redirected to winner (0.2.0).
    expect(graph.overrides.get("/ws/sub/shared-v1/telo.yaml")).toBe("/ws/shared-v2/telo.yaml");

    // sub's edge was repointed in place at the winner.
    expect(graph.importEdges.get("/ws/sub/telo.yaml")?.get("Old")?.targetSource).toBe(
      "/ws/shared-v2/telo.yaml",
    );
  });

  it("does not reconcile namespace-less local libraries that merely share a name", async () => {
    // Two distinct local libraries both named `widget` with no namespace must
    // stay distinct — reconciling them would drop one and break its kinds.
    const noNs = (version: string) =>
      `kind: Telo.Library\nmetadata:\n  name: widget\n  version: ${version}\n`;
    const files: Record<string, string> = {
      "/ws/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: app, version: 1.0.0 }",
        "imports:",
        "  A: ./a",
        "  B: ./b",
      ].join("\n"),
      "/ws/a/telo.yaml": noNs("0.1.0"),
      "/ws/b/telo.yaml": noNs("0.2.0"),
    };

    const graph = await loaderFor(files).loadGraph("/ws/telo.yaml", { desugarImports: true });

    expect(graph.versionDiagnostics).toHaveLength(0);
    expect(graph.overrides.size).toBe(0);
  });

  it("flags an incompatible major mismatch as an error", async () => {
    const files: Record<string, string> = {
      "/ws/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: app, version: 1.0.0 }",
        "imports:",
        "  Shared: ./shared-v2",
        "  Sub: ./sub",
      ].join("\n"),
      "/ws/shared-v2/telo.yaml": lib("std", "shared", "2.0.0"),
      "/ws/sub/telo.yaml": lib("std", "sub", "1.0.0", { Old: "./shared-v1" }),
      "/ws/sub/shared-v1/telo.yaml": lib("std", "shared", "1.0.0"),
    };

    const graph = await loaderFor(files).loadGraph("/ws/telo.yaml", { desugarImports: true });

    expect(graph.versionDiagnostics).toHaveLength(1);
    expect(graph.versionDiagnostics[0].code).toBe("MODULE_VERSION_CONFLICT");
    expect(graph.versionDiagnostics[0].severity).toBe(1); // Error
    // A winner is still chosen (max version) so analysis collapses to one copy.
    expect(graph.overrides.get("/ws/sub/shared-v1/telo.yaml")).toBe("/ws/shared-v2/telo.yaml");
  });

  it("does not emit a spurious DUPLICATE_IMPORT_ALIAS for the skewed shared module", async () => {
    // Mirrors the real bug: two versions of `shared` each carry the same inline
    // import (`Inner`). Pre-reconcile both copies reach analyze() and the alias
    // `Inner` collides in scope `shared`. Post-reconcile only one copy survives.
    const files: Record<string, string> = {
      "/ws/telo.yaml": [
        "kind: Telo.Application",
        "metadata: { name: app, version: 1.0.0 }",
        "imports:",
        "  Shared: ./shared-v2",
        "  Sub: ./sub",
      ].join("\n"),
      "/ws/shared-v2/telo.yaml": lib("std", "shared", "0.2.0", { Inner: "./inner" }),
      "/ws/shared-v2/inner/telo.yaml": lib("std", "inner", "0.1.0"),
      "/ws/sub/telo.yaml": lib("std", "sub", "1.0.0", { Old: "./shared-v1" }),
      "/ws/sub/shared-v1/telo.yaml": lib("std", "shared", "0.1.0", { Inner: "./inner" }),
      "/ws/sub/shared-v1/inner/telo.yaml": lib("std", "inner", "0.1.0"),
    };

    const graph = await loaderFor(files).loadGraph("/ws/telo.yaml", { desugarImports: true });
    const diagnostics = new StaticAnalyzer().analyze(flattenForAnalyzer(graph));

    expect(diagnostics.find((d) => d.code === "DUPLICATE_IMPORT_ALIAS")).toBeUndefined();
    // The additive skew reconciles silently — no version diagnostic.
    expect(graph.versionDiagnostics).toHaveLength(0);
  });
});
