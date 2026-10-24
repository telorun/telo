import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * Where `rethrow:` is legal, read off the owning kind's `x-telo-error-context`
 * regions: the nearest one enclosing it must bind an `error` that cannot be
 * null. Refusal in `finally:` and outside every region is pinned against the
 * step engine in `tests/check-run-agreement.yaml`.
 */
function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports() {
      return true;
    },
    async read(url: string) {
      const file = url in files ? url : `${url.replace(/\/$/, "")}/telo.yaml`;
      const text = files[file];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: file };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

async function refusedPaths(steps: string): Promise<string[]> {
  const files = {
    "/app/telo.yaml": `kind: Telo.Application
metadata:
  name: App
---
kind: Telo.Definition
metadata:
  name: Body
capability: Telo.Runnable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
---
kind: Self.Body
metadata:
  name: body
steps:
${steps}`,
  };
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.code === "RETHROW_WITHOUT_CAUGHT_ERROR")
    .map((d) => String((d.data as { path?: string }).path));
}

describe("a rethrow: step", () => {
  it("is legal at any depth under a catch:, and refused under a finally: nested inside one", async () => {
    expect(
      await refusedPaths(`  - name: attempt
    try:
      - name: fail
        throw: { code: FAILED }
    catch:
      - name: decide
        if: !cel "error.code == 'FAILED'"
        then:
          - name: again
            rethrow: {}
      - name: inner
        try:
          - name: alsoAgain
            rethrow: {}
        finally:
          - name: tooLate
            rethrow: {}
`),
    ).toEqual(["steps[0].catch[1].finally[0].rethrow"]);
  });
});
