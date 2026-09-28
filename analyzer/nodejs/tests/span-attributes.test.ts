import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import type { ManifestSource } from "../src/types.js";

/**
 * The marks only `telo check` can judge: ones no contract reaches, which the
 * kernel never reads. Every placement a contract DOES reach is pinned against
 * the kernel's refusal by the kernel's placement matrix.
 */
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
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

/** `[code, path]` of every mark diagnostic `telo check` reports for a library. */
async function marks(body: string): Promise<Array<[string, string]>> {
  const url = "/lib/telo.yaml";
  const text = [`kind: Telo.Library`, `metadata:`, `  name: Marks`, `  version: 0.1.0`, body].join(
    "\n",
  );
  const graph = await new Loader([inMemorySource({ [url]: text })]).loadGraph(url, {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph))
    .filter((d) => /^(SPAN_ATTRIBUTE|SENSITIVE_ANNOTATION)_/.test(String(d.code)))
    .map((d) => [String(d.code), String((d.data as { path?: string }).path)]);
}

const probe = (inputType: string): string => `---
kind: Telo.Definition
metadata:
  name: Probe
capability: Telo.Invocable
inputType:
${inputType}`;

describe("a mark no contract reaches", () => {
  it("is misplaced in a kind's own schema", async () => {
    expect(
      await marks(`---
kind: Telo.Definition
metadata:
  name: Kind
capability: Telo.Invocable
schema:
  type: object
  properties:
    id: { type: string, x-telo-span-attribute: app.id, x-telo-sensitive: true }`),
    ).toEqual([
      ["SENSITIVE_ANNOTATION_MISPLACED", "schema.properties.id"],
      ["SPAN_ATTRIBUTE_MISPLACED", "schema.properties.id"],
    ]);
  });

  it("is misplaced in a $defs entry nothing references, and read where a property does", async () => {
    expect(
      await marks(
        probe(`  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      turn: { $ref: "#/$defs/Turn" }
    $defs:
      Turn:
        type: object
        properties:
          id: { type: string, x-telo-span-attribute: app.turn.id }
          token: { type: string, x-telo-sensitive: true }
      Unused:
        type: object
        properties:
          id: { type: string, x-telo-span-attribute: app.unused.id }
          token: { type: string, x-telo-sensitive: true }`),
      ),
    ).toEqual([
      ["SENSITIVE_ANNOTATION_MISPLACED", "inputType.schema.$defs.Unused.properties.token"],
      ["SPAN_ATTRIBUTE_MISPLACED", "inputType.schema.$defs.Unused.properties.id"],
    ]);
  });

  it("is misplaced in a named shape no contract uses, unless its library exports it", async () => {
    const shape = `---
kind: Telo.JsonSchema
metadata:
  name: Turn
schema:
  type: object
  properties:
    id: { type: string, x-telo-span-attribute: app.turn.id }
    token: { type: string, x-telo-sensitive: true }`;
    expect(await marks(shape)).toEqual([
      ["SENSITIVE_ANNOTATION_MISPLACED", "schema.properties.token"],
      ["SPAN_ATTRIBUTE_MISPLACED", "schema.properties.id"],
    ]);
    expect(await marks(`exports:\n  resources: [Turn]\n${shape}`)).toEqual([]);
  });

  it("is read from a named shape a contract uses", async () => {
    expect(
      await marks(`---
kind: Telo.JsonSchema
metadata:
  name: Turn
schema:
  type: object
  properties:
    id: { type: string, x-telo-span-attribute: app.turn.id }
    token: { type: string, x-telo-sensitive: true }
${probe(`  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      turn: !ref Turn`)}`),
    ).toEqual([]);
  });
});
