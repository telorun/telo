import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * AN EXPRESSION AT OR ABOVE A REFERENCE SLOT, on a RESOURCE — the second
 * position of the rule `validate-template-body.ts` owns the other half of.
 *
 * A `Telo.Provider`'s whole root is implicitly compile-eval, so an expression
 * there is written in a legal eval site: no CEL rule complained, and nothing
 * looked at what was beneath it. Above a slot it left no concrete reference site
 * at all, so every static check was silent and the kernel expanded it at
 * `create()`.
 */
const app: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "TestApp", version: "1.0.0" },
} as unknown as ResourceManifest;

const handlerKind: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Handler", module: "bus" },
  capability: "Telo.Invocable",
  schema: { type: "object" },
} as unknown as ResourceManifest;

const handler: ResourceManifest = {
  kind: "bus.Handler",
  metadata: { name: "target" },
} as unknown as ResourceManifest;

const cel = (source: string) => makeTaggedSentinel("cel", source);

const busKind = (capability: string, extra: Record<string, unknown> = {}): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name: "Bus", module: "bus" },
    capability,
    schema: {
      type: "object",
      properties: {
        handler: { "x-telo-ref": { kind: "bus.Handler", use: "call" } },
        routes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              handler: { "x-telo-ref": { kind: "bus.Handler", use: "call" } },
            },
          },
        },
        ...extra,
      },
    },
  }) as unknown as ResourceManifest;

const bus = (fields: Record<string, unknown>): ResourceManifest =>
  ({ kind: "bus.Bus", metadata: { name: "bus" }, ...fields }) as unknown as ResourceManifest;

const analyze = (...manifests: ResourceManifest[]) =>
  new StaticAnalyzer().analyze(
    withSyntheticPositions([app, handlerKind, handler, ...manifests]),
  );

const codes = (diags: ReturnType<typeof analyze>, code: string) =>
  diags.filter((d) => d.code === code);

describe("an expression at or above a resource's reference slot", () => {
  it("reports a value computed ABOVE the slot, which leaves no site below it", () => {
    const diags = analyze(
      busKind("Telo.Provider"),
      bus({ routes: cel("[{'handler': 'target'}]") }),
    );
    const computed = codes(diags, "REF_SLOT_COMPUTED");
    expect(computed.map((d) => d.data?.path)).toEqual(["routes"]);
    expect(computed[0]!.message).toContain("holds the reference slot 'routes[].handler'");
    // The repair is to write the slot itself — a resource has no enclosing
    // instance to forward from, which is the template body's half.
    expect(computed[0]!.message).toContain("Write the slot itself as '!ref'");
    expect(computed[0]!.message).not.toContain("self.<path>");
  });

  it("reports an expression AT the slot, and says only that about it", () => {
    const diags = analyze(busKind("Telo.Provider"), bus({ handler: cel("'target'") }));
    expect(codes(diags, "REF_SLOT_COMPUTED").map((d) => d.data?.path)).toEqual(["handler"]);
    // Not also "must have string 'kind' and 'name' fields": that describes the
    // value's shape and leaves an author with nothing to do.
    expect(codes(diags, "INVALID_REFERENCE")).toEqual([]);
  });

  it("reports an expression AT a slot the kind evaluates per call, and says only that", () => {
    const diags = analyze(
      {
        kind: "Telo.Definition",
        metadata: { name: "Bus", module: "bus" },
        capability: "Telo.Invocable",
        schema: {
          type: "object",
          properties: {
            handler: {
              "x-telo-eval": "runtime",
              "x-telo-ref": { kind: "bus.Handler", use: "call" },
            },
          },
        },
      } as unknown as ResourceManifest,
      bus({ handler: cel("'target'") }),
    );
    expect(codes(diags, "REF_SLOT_COMPUTED").map((d) => d.data?.path)).toEqual(["handler"]);
    expect(codes(diags, "INVALID_REFERENCE")).toEqual([]);
  });

  it("leaves a slot the kind does NOT evaluate to the reference rule", () => {
    const diags = analyze(busKind("Telo.Invocable"), bus({ handler: cel("'target'") }));
    expect(codes(diags, "REF_SLOT_COMPUTED")).toEqual([]);
    expect(codes(diags, "INVALID_REFERENCE")).toHaveLength(1);
  });

  it("says nothing about a reference, an inline declaration or a value beside a slot", () => {
    const diags = analyze(
      busKind("Telo.Provider", { label: { type: "string" } }),
      bus({
        handler: makeTaggedSentinel("ref", "target"),
        routes: [{ handler: makeTaggedSentinel("ref", "target") }],
        label: cel("'hello'"),
      }),
    );
    expect(codes(diags, "REF_SLOT_COMPUTED")).toEqual([]);
    expect(codes(diags, "INVALID_REFERENCE")).toEqual([]);
  });

  it("leaves a published dependency's resource alone", () => {
    const diags = analyze(
      {
        ...(busKind("Telo.Provider") as unknown as Record<string, unknown>),
      } as unknown as ResourceManifest,
      {
        ...(bus({ routes: cel("[{'handler': 'target'}]") }) as unknown as Record<string, unknown>),
        metadata: { name: "bus", module: "other" },
      } as unknown as ResourceManifest,
    );
    expect(codes(diags, "REF_SLOT_COMPUTED")).toEqual([]);
  });
});
