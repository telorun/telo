import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * An import's field-by-field `needs:` supply reads the IMPORTING module's
 * `variables`, never the import's own `variables:` values — which, once one of
 * them is a `!cel` value, used to be typed as the declarations.
 */

function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports(url: string) {
      return url.startsWith("/");
    },
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

const LIBRARY = `kind: Telo.Library
metadata: { name: Lib }
needs:
  state:
    kind: Telo.DurableDirectory
variables:
  label:
    type: string
`;

const application = (read: string) => `kind: Telo.Application
metadata: { name: App }
variables:
  label:
    env: LABEL
    type: string
    default: a
  scratch:
    env: SCRATCH
    type: string
    x-telo-type: Telo.HostPath
    default: ./scratch
imports:
  Lib:
    source: ../lib
    needs:
      state: { path: !cel "${read}.joinPath('state')" }
    variables:
      label: !cel "variables.label"
`;

/** The import's own findings, as `[code, path]`. */
async function importFindings(read: string): Promise<Array<[string, string]>> {
  const files = { "/app/telo.yaml": application(read), "/lib/telo.yaml": LIBRARY };
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph))
    .filter((d) => d.message.startsWith("Telo.Import/"))
    .map((d) => [String(d.code), String((d.data as { path?: string } | undefined)?.path)]);
}

describe("an import's needs supply", () => {
  it("reads a variable the importer declares beside a computed import input", async () => {
    expect(await importFindings("variables.scratch")).toEqual([]);
  });

  it("refuses a variable the importer does not declare", async () => {
    expect(await importFindings("variables.missing")).toEqual([["CEL_UNKNOWN_FIELD", "needs.state.path"]]);
  });
});
