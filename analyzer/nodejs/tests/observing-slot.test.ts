import type { ResourceDefinition } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { observesProblems } from "../src/observing-slot.js";

const slot = {
  type: "object",
  properties: {
    access: { "x-telo-ref": { kind: "Kinds.Access", use: "dependency", observes: ["bogus"] } },
  },
};

const store = {
  kind: "Telo.Abstract",
  metadata: { name: "Store" },
  capability: "Telo.Provider",
  schema: slot,
} as unknown as ResourceDefinition;

const writer = {
  kind: "Telo.Definition",
  metadata: { name: "Writer" },
  extends: "Self.Store",
  capability: "Telo.Sink",
  controllers: ["pkg:telo/local/js?path=./x.mjs#Writer"],
} as unknown as ResourceDefinition;

const access = {
  kind: "Telo.Definition",
  metadata: { name: "Access" },
  needType: { fields: {}, required: [], version: "semver" },
} as unknown as ResourceDefinition;

const resolve = (kind: string) =>
  kind === "Self.Store" ? store : kind === "Kinds.Access" ? access : undefined;

describe("observesProblems", () => {
  it("judges an inherited slot's tokens at its declarer only, and its holder at the implementation's extends", () => {
    const atDeclarer = observesProblems(store, slot, slot, resolve).problems;
    const atImplementation = observesProblems(writer, undefined, slot, resolve).problems;

    expect(atDeclarer.map((p) => p.path)).toEqual(["schema.properties.access.x-telo-ref.observes"]);
    expect(atImplementation).toEqual([
      expect.objectContaining({
        path: "extends",
        message: expect.stringContaining(
          "x-telo-ref at 'schema.properties.access', inherited from Telo.Abstract 'Store', declares 'observes', but kind capability 'Telo.Sink'",
        ),
      }),
    ]);
  });
});
