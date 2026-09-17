import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { AnalysisRegistry } from "../src/analysis-registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A `Telo.Abstract` names a contract for `x-telo-ref` slots and has no
 * controller, so the kernel refuses one at `create()`. Nothing said so
 * statically: `kind: Telo.Invocable` and `kind: Sql.Connection` both passed
 * `telo check` and then failed at boot, leaving the checker more permissive
 * than the runtime it predicts.
 *
 * The editor half is the same question asked from the other side: the create
 * picker offered `Telo.Invocable` at every step's `invoke:`, because the
 * accepted set of `Telo.Executable` legitimately contains the two abstracts
 * that extend it.
 */

const app = {
  kind: "Telo.Application",
  metadata: { name: "App" },
} as unknown as ResourceManifest;

const libImport = {
  kind: "Telo.Import",
  metadata: { name: "Sql", resolvedModuleName: "sql" },
  source: "./sql",
} as unknown as ResourceManifest;

const connectionAbstract = {
  kind: "Telo.Abstract",
  metadata: { name: "Connection", module: "sql" },
  capability: "Telo.Provider",
} as unknown as ResourceManifest;

const sqliteImport = {
  kind: "Telo.Import",
  metadata: { name: "Sqlite", resolvedModuleName: "sqlite" },
  source: "./sqlite",
} as unknown as ResourceManifest;

const sqliteConnection = {
  kind: "Telo.Definition",
  metadata: { name: "Connection", module: "sqlite" },
  capability: "Telo.Provider",
  extends: "sql.Connection",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

/** A kind with a step body, so an inline declaration at `invoke:` is reachable
 *  only through the local `$ref` the field map does not follow. */
const sequenceDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "run" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    $defs: {
      step: {
        type: "object",
        properties: {
          name: { type: "string" },
          invoke: {
            "x-telo-topology-role": "invoke",
            anyOf: [{ "x-telo-ref": "Telo.Invocable" }],
          },
        },
      },
    },
    properties: {
      steps: {
        "x-telo-topology-role": "steps",
        type: "array",
        items: { $ref: "#/$defs/step" },
      },
    },
  },
} as unknown as ResourceManifest;

function analyze(docs: ResourceManifest[]) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(docs))
    .filter((d) => d.code === "ABSTRACT_KIND_INSTANTIATED");
}

describe("a resource declared with an abstract kind", () => {
  it("is rejected for a built-in capability abstract", () => {
    const [diagnostic] = analyze([
      app,
      { kind: "Telo.Invocable", metadata: { name: "invocable" } } as unknown as ResourceManifest,
    ]);
    expect(diagnostic?.message).toContain("Telo.Invocable");
    expect(diagnostic?.message).toContain("abstract and cannot be instantiated");
    expect(diagnostic?.data?.path).toBe("kind");
  });

  it("is rejected for a module abstract", () => {
    const [diagnostic] = analyze([
      app,
      libImport,
      connectionAbstract,
      { kind: "Sql.Connection", metadata: { name: "conn" } } as unknown as ResourceManifest,
    ]);
    expect(diagnostic?.message).toContain("Sql.Connection");
  });

  // Alias form, never canonical: `sqlite.Connection` is what the registry is
  // keyed on and is not something anyone can type.
  it("names its implementations as the author would spell them", () => {
    const [diagnostic] = analyze([
      app,
      libImport,
      connectionAbstract,
      sqliteImport,
      sqliteConnection,
      { kind: "Sql.Connection", metadata: { name: "conn" } } as unknown as ResourceManifest,
    ]);
    expect(diagnostic?.message).toContain("Sqlite.Connection");
    expect(diagnostic?.message).not.toContain("sqlite.Connection");
  });

  it("is rejected when written inline at a reference slot", () => {
    const [diagnostic] = analyze([
      app,
      libImport,
      connectionAbstract,
      sequenceDef,
      {
        kind: "run.Sequence",
        metadata: { name: "seq" },
        steps: [{ name: "one", invoke: { kind: "Sql.Connection" } }],
      } as unknown as ResourceManifest,
    ]);
    expect(diagnostic?.message).toContain("Sql.Connection");
    expect(diagnostic?.data?.path).toBe("steps[0].invoke.kind");
  });

  it("leaves a concrete kind alone", () => {
    expect(
      analyze([
        app,
        libImport,
        connectionAbstract,
        sqliteImport,
        sqliteConnection,
        { kind: "Sqlite.Connection", metadata: { name: "conn" } } as unknown as ResourceManifest,
      ]),
    ).toEqual([]);
  });
});

describe("what a reference slot offers to create", () => {
  it("drops the abstracts in the accepted set and keeps the implementations", () => {
    const registry = new AnalysisRegistry();
    new StaticAnalyzer().analyze(
      withSyntheticPositions([app, libImport, connectionAbstract, sqliteImport, sqliteConnection]),
      undefined,
      registry,
    );

    // `Telo.Runnable` and `Telo.Invocable` both extend `Telo.Executable`, so
    // they are substitutable at the slot and constructible at none of it.
    expect(registry.acceptedKindsForRef("Telo.Executable")).toContain("Telo.Invocable");
    expect(registry.userFacingKindsForRef("Telo.Executable")).not.toContain("Telo.Invocable");

    expect(registry.userFacingKindsForRef("sql.Connection")).toEqual(["Sqlite.Connection"]);
  });
});
