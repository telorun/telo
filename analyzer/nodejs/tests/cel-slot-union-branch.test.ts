import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A CEL value inside a union-typed slot is typed against the ONE branch the
 *  value was written against; a union that leaves more than one branch open is
 *  left unchecked rather than guessed. */
function typeErrors(branches: Record<string, unknown>[], item: Record<string, unknown>) {
  const manifests = [
    { kind: "Telo.Application", metadata: { name: "app", source: "telo.yaml" } },
    {
      kind: "Telo.Definition",
      metadata: { name: "Pick", module: "app" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: { list: { type: "array", "x-telo-eval": "compile", items: { anyOf: branches } } },
      },
    },
    { kind: "app.Pick", metadata: { name: "pick", source: "telo.yaml" }, list: [item] },
  ] as unknown as ResourceManifest[];
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "CEL_TYPE_ERROR")
    .map((d) => d.message);
}

const cel = (source: string) => ({ __tagged: true, engine: "cel", source });

describe("a CEL value under a union", () => {
  it("is typed against the branch its keys select", () => {
    const errors = typeErrors(
      [
        { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        { type: "object", required: ["when"], properties: { when: { type: "boolean" } } },
      ],
      { when: cel("'false'") },
    );
    expect(errors).toEqual(["app.Pick/pick: CEL at 'list[0].when' returns 'string' but the field expects 'boolean'."]);
  });

  it("is left unchecked when more than one branch fits", () => {
    const errors = typeErrors(
      [
        { type: "object", properties: { when: { type: "boolean" } } },
        { type: "object", properties: { when: { type: "string" } } },
      ],
      { when: cel("'false'") },
    );
    expect(errors).toEqual([]);
  });
});
