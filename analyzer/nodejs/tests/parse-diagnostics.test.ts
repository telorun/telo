import { describe, expect, it } from "vitest";
import { Loader } from "../src/manifest-loader.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";

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

describe("Loader.loadGraph — parseDiagnostics", () => {
  it("surfaces a YAML parse failure as a fatal Error diagnostic with a range", async () => {
    // The unquoted description contains `: ` (colon-space) inside backticks,
    // which the spec-compliant yaml parser reads as a nested mapping. Before
    // this was wired up, `doc.toJSON()` returned a mangled tree and the failure
    // was silently swallowed — static analysis reported "passed".
    const appText = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "  version: 1.0.0",
      "outputType:",
      "  schema:",
      "    properties:",
      "      content:",
      "        description: File contents — base64 when `encoding: base64`.",
    ].join("\n");

    const source = inMemorySource({ "/ws/telo.yaml": appText });
    const loader = new Loader([source]);

    const graph = await loader.loadGraph("/ws/telo.yaml");

    expect(graph.parseDiagnostics).toHaveLength(1);
    const d = graph.parseDiagnostics[0];
    expect(d.code).toBe("MANIFEST_PARSE_FAILED");
    expect(d.severity).toBe(DiagnosticSeverity.Error);
    expect((d.data as { filePath?: string }).filePath).toBe("/ws/telo.yaml");
    // The failing `: ` sits at line 9 (1-based) → line 8 (0-based).
    expect(d.range?.start.line).toBe(8);
    // The raw yaml message is augmented with an actionable quoting hint.
    expect(d.message).toContain("Wrap the value in quotes");
  });

  it("reports no parse diagnostics for a well-formed manifest", async () => {
    const appText = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "  version: 1.0.0",
    ].join("\n");

    const source = inMemorySource({ "/ws/telo.yaml": appText });
    const loader = new Loader([source]);

    const graph = await loader.loadGraph("/ws/telo.yaml");
    expect(graph.parseDiagnostics).toHaveLength(0);
  });
});
