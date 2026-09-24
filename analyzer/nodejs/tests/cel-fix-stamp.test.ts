import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";

import { StaticAnalyzer } from "../src/analyzer.js";
import { diagnosticFix } from "../src/types.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A repair is always a whole-scalar replacement: the engine computes it against
 * one expression and re-anchors it onto the scalar it came from, so a hole's
 * repair keeps the text around it.
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

  it("carries no sub-range — the replacement IS the whole value", () => {
    // A range beside a whole-value replacement gives the field two readings,
    // and the minimal-edit one (splice `replacement` at `range`) duplicates
    // text, because the two measure different strings.
    expect(fixFor(makeTaggedSentinel("cel", "startsWith(a.b, 'x')"))).toEqual({
      replacement: "a.b.startsWith('x')",
    });
  });

  it("re-anchors a hole's fix onto the whole !interpolate text", () => {
    expect(
      fixFor(makeTaggedSentinel("interpolate", "prefix ${{ startsWith(a.b, 'x') }} suffix"))
        ?.replacement,
    ).toBe("prefix ${{ a.b.startsWith('x') }} suffix");
  });
});
