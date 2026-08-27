import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/**
 * A boot target takes a `Telo.Runnable` or a `Telo.Service`, and until this was
 * fixed nothing enforced it: the check gave up whenever the analysis contained
 * no kind implementing the target abstract, which is precisely the case where
 * every boot target in the app is wrong. An application importing only invocable
 * kinds passed `telo check` and then failed at boot with
 * `Resource not found for invocation: undefined`.
 *
 * The leniency it replaces is real, so both halves are asserted: a candidate
 * whose own ancestry is fully loaded is judged, and one whose ancestry reaches a
 * kind this analysis never saw is not.
 */

const invocableDef = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "javascript" },
  capability: "Telo.Invocable",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

const runnableDef = {
  kind: "Telo.Definition",
  metadata: { name: "Sequence", module: "run" },
  capability: "Telo.Runnable",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

/** A kind whose parent is not in the analysis — the partial context the old
 *  blanket leniency existed for. */
const orphanDef = {
  kind: "Telo.Definition",
  metadata: { name: "Task", module: "vendor" },
  extends: "Absent.Base",
  schema: { type: "object", additionalProperties: true },
} as unknown as ResourceManifest;

function analyze(targets: unknown[], docs: ResourceManifest[]): string[] {
  const app = {
    kind: "Telo.Application",
    metadata: { name: "App" },
    targets,
  } as unknown as ResourceManifest;
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions([app, ...docs]))
    .filter((d) => d.code === "REFERENCE_KIND_MISMATCH")
    .map((d) => d.message);
}

const script = { kind: "javascript.Script", metadata: { name: "script" } } as unknown as ResourceManifest;
const sequence = { kind: "run.Sequence", metadata: { name: "pipeline" } } as unknown as ResourceManifest;
const task = { kind: "vendor.Task", metadata: { name: "task" } } as unknown as ResourceManifest;

describe("a boot target's kind", () => {
  it("rejects an invocable, even when no runnable is loaded to compare against", () => {
    const [message] = analyze([makeTaggedSentinel("ref", "script")], [invocableDef, script]);
    expect(message).toContain("javascript.Script");
    expect(message).toContain("Telo.Runnable");
    // What the kind IS, since there is no implementation list to offer — the
    // half that points at the fix (a step's `invoke:`, not a boot target).
    expect(message).toContain("Telo.Invocable");
  });

  it("accepts a runnable", () => {
    expect(analyze([makeTaggedSentinel("ref", "pipeline")], [runnableDef, sequence])).toEqual([]);
  });

  it("still rejects an invocable when a runnable IS loaded", () => {
    const [message] = analyze(
      [makeTaggedSentinel("ref", "script")],
      [invocableDef, runnableDef, script, sequence],
    );
    expect(message).toContain("javascript.Script");
    expect(message).toContain("known implementations");
  });

  // The case a "does it have a dot" rule got wrong. A kind reached through a
  // DECLARED alias that this analysis could not resolve is partial context — the
  // import's definitions are simply not here — while a prefix naming no import
  // is a bad name, and the two are told apart by asking the alias scope.
  it("says nothing about an unresolved kind reached through a declared alias", () => {
    const app = {
      kind: "Telo.Application",
      metadata: { name: "App" },
      targets: [makeTaggedSentinel("ref", "writer")],
    } as unknown as ResourceManifest;
    const imp = {
      kind: "Telo.Import",
      metadata: { name: "Console", resolvedModuleName: "console" },
      source: "../console",
    } as unknown as ResourceManifest;
    const writer = {
      kind: "Console.WriteLine",
      metadata: { name: "writer" },
    } as unknown as ResourceManifest;
    const messages = new StaticAnalyzer()
      .analyze(withSyntheticPositions([app, imp, writer]))
      .filter((d) => d.code === "REFERENCE_KIND_MISMATCH");
    expect(messages).toEqual([]);
  });

  it("says nothing about a kind whose own ancestry is not loaded", () => {
    expect(analyze([makeTaggedSentinel("ref", "task")], [orphanDef, task])).toEqual([]);
  });

  // The guard is about the candidate, so it holds for a CONCRETE target too:
  // the missing hop is exactly where the kind it does not appear to reach could
  // have been declared.
  it("says nothing about an unloaded ancestry at a concrete target either", () => {
    const concreteTarget = {
      kind: "Telo.Definition",
      metadata: { name: "Pool", module: "db" },
      capability: "Telo.Provider",
      schema: {
        type: "object",
        properties: { pool: { "x-telo-ref": "db.Pool", type: "object" } },
      },
    } as unknown as ResourceManifest;
    const holderDef = {
      kind: "Telo.Definition",
      metadata: { name: "Holder", module: "db" },
      capability: "Telo.Runnable",
      schema: {
        type: "object",
        properties: { pool: { "x-telo-ref": "db.Pool", type: "object" } },
      },
    } as unknown as ResourceManifest;
    const holder = {
      kind: "db.Holder",
      metadata: { name: "holder" },
      pool: makeTaggedSentinel("ref", "task"),
    } as unknown as ResourceManifest;
    const app = { kind: "Telo.Application", metadata: { name: "App" } } as unknown as ResourceManifest;
    const messages = new StaticAnalyzer()
      .analyze(withSyntheticPositions([app, concreteTarget, holderDef, orphanDef, task, holder]))
      .filter((d) => d.code === "REFERENCE_KIND_MISMATCH");
    expect(messages).toEqual([]);
  });
});
