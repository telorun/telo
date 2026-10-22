import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { normalizeInlineResources } from "../src/normalize-inline-resources.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

// A property name holding a dot is one key: `font.body` is a slot of its own,
// and the sibling object `font` holding a plain `body` string is not a slot.
const fontDef = {
  kind: "Telo.Definition",
  metadata: { name: "Font", module: "demo" },
  capability: "Telo.Provider",
  controllers: ["pkg:npm/@demo/font@1.0.0"],
  schema: {
    type: "object",
    properties: { family: { type: "string" } },
    required: ["family"],
    additionalProperties: false,
  },
} as unknown as ResourceManifest;

const tokensDef = {
  kind: "Telo.Definition",
  metadata: { name: "Tokens", module: "demo" },
  capability: "Telo.Provider",
  controllers: ["pkg:npm/@demo/tokens@1.0.0"],
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      "font.body": { "x-telo-ref": { kind: "demo.Font", use: "dependency" } },
      font: { type: "object", properties: { body: { type: "string" } } },
    },
  },
} as unknown as ResourceManifest;

const tokens = (body: unknown) =>
  ({
    kind: "demo.Tokens",
    metadata: { name: "tokens", module: "demo" },
    "font.body": body,
    font: { body: "not a reference" },
  }) as unknown as ResourceManifest;

function registry(): DefinitionRegistry {
  const defs = new DefinitionRegistry();
  defs.register(fontDef as never);
  defs.register(tokensDef as never);
  return defs;
}

const errors = (manifests: ResourceManifest[]) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions([fontDef, tokensDef, ...manifests]))
    .filter((d) => d.severity === 1)
    .map((d) => ({ code: d.code, path: (d.data as { path?: string } | undefined)?.path }));

describe("a reference slot under a property name holding a dot", () => {
  it("extracts an inline declaration written there, at that key", () => {
    const out = normalizeInlineResources([tokens({ kind: "demo.Font", family: "Inter" })], registry());
    const holder = out.find((m) => m.metadata?.name === "tokens") as Record<string, any>;
    expect(holder["font.body"]).toEqual({ kind: "demo.Font", name: "tokens_font_body" });
    expect(holder.font).toEqual({ body: "not a reference" });
    const font = out.find((m) => m.metadata?.name === "tokens_font_body")!;
    expect(font).toMatchObject({ kind: "demo.Font", family: "Inter" });
    expect(font.metadata.xTeloOrigin).toMatchObject({
      pathFromParent: "font.body",
      keysFromParent: ["font.body"],
    });
  });

  it("types the extracted declaration by its own kind", () => {
    expect(errors([tokens({ kind: "demo.Font", family: "Inter" })])).toEqual([]);
    expect(errors([tokens({ kind: "demo.Font", famly: "Inter" })]).map((d) => d.code)).toEqual([
      "SCHEMA_VIOLATION",
      "SCHEMA_VIOLATION",
    ]);
  });

  it("refuses a reference to a missing resource at that key", () => {
    expect(errors([tokens(makeTaggedSentinel("ref", "nope"))])).toEqual([
      { code: "UNRESOLVED_REFERENCE", path: "font.body" },
    ]);
  });
});
