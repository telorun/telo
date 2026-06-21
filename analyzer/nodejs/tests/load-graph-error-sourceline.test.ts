import { describe, expect, it } from "vitest";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/** In-memory ManifestSource backed by a flat path → text map. Lets the test
 *  drive `Loader.loadGraph` without touching disk or the network. */
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

describe("Loader.loadGraph — error sourceLine", () => {
  it("stamps the failing Telo.Import's source line on graph errors", async () => {
    // Telo.Import is on the *fourth* document; the import doc starts on
    // source line 11 (0-indexed). loadGraph should stamp that line on the
    // GraphLoadError when the import target can't be loaded.
    const appText = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "  version: 1.0.0",
      "---",
      "kind: Http.Server",
      "metadata:",
      "  name: main",
      "port: 8080",
      "",
      "---", // line 10 (0-indexed)
      "kind: Telo.Import", // line 11
      "metadata:",
      "  name: Missing",
      "source: ./does-not-exist",
      "",
    ].join("\n");

    const source = inMemorySource({ "/ws/telo.yaml": appText });
    const loader = new Loader([source]);

    const graph = await loader.loadGraph("/ws/telo.yaml");

    expect(graph.errors).toHaveLength(1);
    const err = graph.errors[0];
    const stampedLine = (err.error as { sourceLine?: number }).sourceLine;
    // The Telo.Import block starts at line 11 — that's the line a host's
    // diagnostic should pin the failure to. Pre-fix this was always 0 because
    // parseLoadedFile doesn't stamp `sourceLine` onto manifest metadata.
    expect(stampedLine).toBe(11);
  });

  it("stamps the failing Telo.Import's source line when target is a Telo.Application", async () => {
    const appText = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "  version: 1.0.0",
      "---",
      "kind: Telo.Import",
      "metadata:",
      "  name: Other",
      "source: ./other",
      "",
    ].join("\n");

    const otherText = [
      "kind: Telo.Application",
      "metadata:",
      "  name: other",
      "  version: 1.0.0",
      "",
    ].join("\n");

    const source = inMemorySource({
      "/ws/telo.yaml": appText,
      "/ws/other/telo.yaml": otherText,
    });
    const loader = new Loader([source]);

    // assertImportTargetIsLibrary throws synchronously on Application targets.
    // The thrown error carries `sourceLine` for hosts that pin diagnostics.
    let caught: unknown;
    try {
      await loader.loadGraph("/ws/telo.yaml");
    } catch (e) {
      caught = e;
    }
    expect(caught, "expected loadGraph to throw on Application import target").toBeTruthy();
    // Telo.Import block starts at line 5.
    expect((caught as { sourceLine?: number }).sourceLine).toBe(5);
  });
});
