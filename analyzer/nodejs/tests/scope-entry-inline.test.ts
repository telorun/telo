import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A scope field (`x-telo-scope`, e.g. Run.Sequence's `with`) declares its own
 *  inline resource definitions — it is registered as a set of child manifests.
 *  A `!ref` there is a category error: it resolves to a `{kind, name}` reference,
 *  which would be registered as a config-less manifest at runtime. The analyzer
 *  must flag it (`SCOPE_ENTRY_NOT_INLINE`) rather than let it corrupt silently. */

const seqDef = {
  kind: "Telo.Definition",
  metadata: { name: "Seq", module: "run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      with: { "x-telo-scope": ["/targets"], type: "array", items: { type: "object" } },
      targets: {
        type: "array",
        items: {
          anyOf: [
            { type: "string", "x-telo-ref": "telo#Runnable" },
            { type: "string", "x-telo-ref": "telo#Service" },
          ],
        },
      },
    },
  },
} as unknown as ResourceManifest;

const serverDef = {
  kind: "Telo.Definition",
  metadata: { name: "Server", module: "demo" },
  capability: "Telo.Service",
  schema: { type: "object", required: ["port"], properties: { port: { type: "integer" } } },
} as unknown as ResourceManifest;

const base = [seqDef, serverDef];

const scopeErrors = (m: ResourceManifest[]) =>
  new StaticAnalyzer()
    .analyze(withSyntheticPositions(m))
    .filter((d) => d.code === "SCOPE_ENTRY_NOT_INLINE");

describe("scope entries must be inline resource definitions", () => {
  it("flags a `!ref` in a scope (`with`) field", () => {
    const seq = {
      kind: "run.Seq",
      metadata: { name: "Main" },
      with: [makeTaggedSentinel("ref", "TopServer")],
      targets: [makeTaggedSentinel("ref", "TopServer")],
    } as unknown as ResourceManifest;

    const diags = scopeErrors([...base, seq]);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("!ref TopServer");
    expect((diags[0].data as { path: string }).path).toBe("with[0]");
  });

  it("accepts an inline resource definition in a scope field", () => {
    const seq = {
      kind: "run.Seq",
      metadata: { name: "Main" },
      with: [{ kind: "demo.Server", metadata: { name: "Scoped" }, port: 8080 }],
      targets: [makeTaggedSentinel("ref", "Scoped")],
    } as unknown as ResourceManifest;

    expect(scopeErrors([...base, seq])).toEqual([]);
  });
});
