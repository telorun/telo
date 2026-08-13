import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";

import { StaticAnalyzer } from "../src/analyzer.js";
import { diagnosticFix } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A repair is computed by the templating engine against the bare expression, but
 * whether it can be APPLIED is a property of how that expression sits in its
 * scalar — which only the analyzer knows. These are the two halves that live
 * here and nowhere else: the gate that withholds a fix when replacing the node
 * would destroy surrounding text, and the re-wrap that restores `${{ }}`
 * delimiters so the replacement is a whole scalar rather than a bare expression
 * the runtime would read back as literal text.
 */
describe("CEL fix stamping", () => {
  const definition = {
    kind: "Telo.Definition",
    metadata: { name: "Thing", module: "mod" },
    capability: "Telo.Invocable",
    schema: {
      type: "object",
      properties: { label: { type: "string", "x-telo-eval": "runtime" } },
    },
  } as unknown as ResourceManifest;

  function fixFor(label: unknown) {
    const manifests = [
      definition,
      { kind: "mod.Thing", metadata: { name: "t", source: "telo.yaml" }, label },
    ] as unknown as ResourceManifest[];
    const wrongForm = new StaticAnalyzer()
      .analyze(withSyntheticPositions(manifests))
      .find((d) => d.code === "CEL_WRONG_CALL_FORM");
    expect(wrongForm, "expected a CEL_WRONG_CALL_FORM diagnostic").toBeDefined();
    return diagnosticFix(wrongForm!);
  }

  it("stamps a tagged scalar's fix verbatim — the scalar IS the expression", () => {
    expect(fixFor(makeTaggedSentinel("cel", "startsWith(a.b, 'x')"))?.replacement).toBe(
      "a.b.startsWith('x')",
    );
  });

  it("re-wraps a pure `${{ }}` scalar so the replacement stays an expression", () => {
    // Without the re-wrap this would write `a.b.startsWith('x')` into the
    // manifest as literal text — valid YAML, silently never evaluated.
    const fix = fixFor("${{ startsWith(a.b, 'x') }}");
    expect(fix?.replacement).toBe("${{ a.b.startsWith('x') }}");
  });

  it("carries no sub-range — the replacement IS the whole value", () => {
    // A range beside a whole-value replacement gives the field two readings,
    // and the minimal-edit one (splice `replacement` at `range`) duplicates
    // text, because the two measure different strings.
    expect(fixFor(makeTaggedSentinel("cel", "startsWith(a.b, 'x')"))).toEqual({
      replacement: "a.b.startsWith('x')",
    });
  });

  it("withholds a fix for one interpolation among literal text", () => {
    // Replacing the scalar would drop "prefix " and " suffix", so the
    // correction stays in the message and nothing claims to be applicable.
    expect(fixFor("prefix ${{ startsWith(a.b, 'x') }} suffix")).toBeUndefined();
  });
});
