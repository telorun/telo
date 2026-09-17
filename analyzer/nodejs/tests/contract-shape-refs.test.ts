import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * A kind's contract naming a shape with `!ref` — resolved in the module that
 * declared the kind, whether that is the module under analysis or a library it
 * imports, and reported where it resolves to nothing.
 */

function source(files: Record<string, string>): ManifestSource {
  return {
    supports: () => true,
    async read(url: string) {
      const text = files[url];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: url };
    },
    resolveRelative: (base: string, relative: string) => new URL(relative, `file://${base}`).pathname,
  };
}

async function check(files: Record<string, string>, entry: string) {
  const graph = await new Loader([source(files)]).loadGraph(entry, { desugarImports: true });
  return new StaticAnalyzer().analyze(flattenForAnalyzer(graph));
}

const handlerLibrary = `kind: Telo.Library
metadata: { name: Billing, version: 0.1.0 }
exports: { kinds: [Handler] }
---
kind: Telo.JsonSchema
metadata: { name: Money }
schema: { type: object, required: [amount], properties: { amount: { type: integer } } }
---
kind: Telo.Abstract
metadata: { name: Handler }
capability: Telo.Invocable
outputType: !ref Money
`;

const implementation = (prefix: string) => `---
kind: Telo.JsonSchema
metadata: { name: Other }
schema: { type: string }
---
kind: Telo.Definition
metadata: { name: Impl }
extends: ${prefix}.Handler
outputType: !ref Other
controllers:
  - pkg:telo/local/js?path=./nowhere.mjs#Never
`;

describe("a kind's contract naming a shape with !ref", () => {
  it("is compared through the shape, in the declaring module and from an importer", async () => {
    const local = await check(
      { "/lib/telo.yaml": handlerLibrary + implementation("Self") },
      "/lib/telo.yaml",
    );
    const imported = await check(
      {
        "/lib/telo.yaml": handlerLibrary,
        "/app/telo.yaml":
          `kind: Telo.Library\nmetadata: { name: Shop, version: 0.1.0 }\nimports: { Billing: ../lib/telo.yaml }\n` +
          implementation("Billing"),
      },
      "/app/telo.yaml",
    );
    for (const diagnostics of [local, imported]) {
      expect(diagnostics.map((d) => d.code)).toEqual(["CONTRACT_NOT_SUBSTITUTABLE"]);
      expect(diagnostics[0]!.message).toContain("`outputType` replaces the one declared by 'Billing.Handler'");
    }
  });

  it("reports a reference that names nothing, at the root and nested", async () => {
    const diagnostics = await check(
      {
        "/lib/telo.yaml": `kind: Telo.Library
metadata: { name: Billing, version: 0.1.0 }
---
kind: Telo.Abstract
metadata: { name: Handler }
capability: Telo.Invocable
inputType: { type: object, properties: { price: !ref Missing } }
outputType: !ref Nope
`,
      },
      "/lib/telo.yaml",
    );
    expect(
      diagnostics.map((d) => [d.code, (d.data as { path?: string }).path]),
    ).toEqual([
      ["CONTRACT_TYPE_NOT_FOUND", "inputType.properties.price"],
      ["CONTRACT_TYPE_NOT_FOUND", "outputType"],
    ]);
  });
});
