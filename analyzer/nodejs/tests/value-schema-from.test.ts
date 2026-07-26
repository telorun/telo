import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A decision-table-shaped definition: one declared `outputType` and several
 * slots that must each produce it. Both value slots carry
 * `x-telo-value-schema-from: outputType`, which is the whole mechanism under
 * test — no kind is hardcoded in the analyzer.
 */
const choiceDef = {
  kind: "Telo.Definition",
  metadata: { name: "Choice", module: "run" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: {
      inputs: { type: "object", additionalProperties: true },
      outputType: { "x-telo-ref": "telo#Type" },
      choices: {
        type: "array",
        "x-telo-context": {
          type: "object",
          properties: { inputs: { type: "object", "x-telo-context-from": "inputs" } },
        },
        items: {
          type: "object",
          properties: {
            when: { type: "boolean" },
            value: { "x-telo-value-schema-from": "outputType" },
          },
        },
      },
      default: {
        type: "object",
        properties: { value: { "x-telo-value-schema-from": "outputType" } },
      },
    },
  },
} as unknown as ResourceManifest;

/** Sequence-shaped host so a Choice can be written INLINE at a step's `invoke`,
 *  proving the check does not depend on where the author put the resource. */
const sequenceDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            invoke: { anyOf: [{ "x-telo-ref": "telo#Invocable" }] },
          },
        },
      },
    },
  },
} as unknown as ResourceManifest;

const TIER_SCHEMA = {
  type: "object",
  required: ["tier", "cost"],
  additionalProperties: false,
  properties: { tier: { type: "string" }, cost: { type: "number" } },
};

const namedType = {
  kind: "Type.JsonSchema",
  metadata: { name: "Tier", module: "test" },
  schema: TIER_SCHEMA,
} as unknown as ResourceManifest;

function violations(manifests: ResourceManifest[]) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "SCHEMA_VIOLATION");
}

function choice(extra: Record<string, unknown>): ResourceManifest {
  return {
    kind: "run.Choice",
    metadata: { name: "Tier", module: "test" },
    inputs: { order: {} },
    ...extra,
  } as unknown as ResourceManifest;
}

const inlineOutputType = { kind: "Type.JsonSchema", schema: TIER_SCHEMA };

describe("x-telo-value-schema-from", () => {
  it("flags a losing row that disagrees with the declared type", () => {
    // choices[0] is correct and would win for most inputs; the point of the
    // check is that choices[1] is reported anyway.
    const found = violations([
      choiceDef,
      choice({
        outputType: inlineOutputType,
        choices: [
          { when: true, value: { tier: "free", cost: 0 } },
          { when: false, value: { tier: "freight", costt: 60 } },
        ],
      }),
    ]);
    expect(found.length).toBeGreaterThan(0);
    for (const d of found) expect(d.message).toContain("`choices[1].value`");
    expect(found.some((d) => d.message.includes("required property 'cost'"))).toBe(true);
    expect(found.some((d) => d.message.includes("'costt' is not allowed"))).toBe(true);
  });

  it("does not flag CEL leaves, which no static pass can resolve", () => {
    expect(
      violations([
        choiceDef,
        choice({
          outputType: inlineOutputType,
          choices: [
            {
              when: true,
              // A CEL leaf becomes a schema-shaped placeholder, so it is accepted
              // wherever its slot's declared type would be.
              value: { tier: "freight", cost: "${{ inputs.order.weight * 2.0 }}" },
            },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("checks the default slot too", () => {
    const found = violations([
      choiceDef,
      choice({
        outputType: inlineOutputType,
        choices: [{ when: true, value: { tier: "free", cost: 0 } }],
        default: { value: { tier: "standard" } },
      }),
    ]);
    expect(found.length).toBe(1);
    expect(found[0].message).toContain("`default.value`");
    expect(found[0].message).toContain("required property 'cost'");
  });

  it("resolves a named type reference, not only an inline one", () => {
    const found = violations([
      choiceDef,
      namedType,
      choice({ outputType: "Tier", choices: [{ when: true, value: { tier: "free" } }] }),
    ]);
    expect(found.length).toBe(1);
    expect(found[0].message).toContain("required property 'cost'");
  });

  it("skips the check when no type is declared — declaring it is what opts in", () => {
    expect(
      violations([choiceDef, choice({ choices: [{ when: true, value: { anything: 1 } }] })]),
    ).toEqual([]);
  });

  it("applies to an inline resource, not only a top-level one", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Flow", module: "test" },
      steps: [
        {
          name: "pick",
          invoke: {
            kind: "run.Choice",
            inputs: { order: {} },
            outputType: inlineOutputType,
            choices: [{ when: true, value: { tier: "free", costt: 0 } }],
          },
        },
      ],
    } as unknown as ResourceManifest;

    // An inline resource at an `x-telo-ref` slot is EXTRACTED into its own
    // synthetic manifest, so the check runs on it through the top-level loop and
    // the diagnostic is anchored back to the concrete path inside the parent.
    // The route differs from a standalone resource; the coverage must not.
    const found = violations([choiceDef, sequenceDef, seq]);
    expect(found.length).toBeGreaterThan(0);
    for (const d of found) {
      expect(d.message).toContain("`choices[0].value`");
      expect(d.data?.path).toContain("steps[0].invoke.choices[0].value");
    }
    expect(found.some((d) => d.message.includes("required property 'cost'"))).toBe(true);
    expect(found.some((d) => d.message.includes("'costt' is not allowed"))).toBe(true);
  });
});
