import type { ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { createAjv } from "../src/schema-compat.js";

/** End-to-end analyzer coverage for the new `!ref <name>` YAML tag and the
 *  shared `ResourceRef` schema fragment registered under `telo://manifest`. */

const app: ResourceManifest = {
  kind: "Telo.Application",
  metadata: { name: "test-app", version: "1.0.0" },
} as unknown as ResourceManifest;

const scriptDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Script", module: "std" },
  capability: "Telo.Invocable",
  schema: {
    type: "object",
    properties: { code: { type: "string" } },
  },
} as unknown as ResourceManifest;

/** A definition whose schema declares a plain ref slot — the simple case
 *  the walker fully covers (no `oneOf` / `$ref` wrapping). */
const dispatcherDef: ResourceManifest = {
  kind: "Telo.Definition",
  metadata: { name: "Dispatcher", module: "std" },
  capability: "Telo.Runnable",
  schema: {
    type: "object",
    properties: {
      handler: { "x-telo-ref": "std#Script" },
    },
  },
} as unknown as ResourceManifest;

const base = [app, scriptDef, dispatcherDef];

describe("`!ref` sentinel at a top-level ref slot", () => {
  it("resolves the sentinel to {kind, name} after analyzer.normalize()", () => {
    const knownScript: ResourceManifest = {
      kind: "std.Script",
      metadata: { name: "DoStuff" },
      code: "noop",
    } as unknown as ResourceManifest;
    const dispatcher: ResourceManifest = {
      kind: "std.Dispatcher",
      metadata: { name: "Main" },
      handler: makeTaggedSentinel("ref", "DoStuff"),
    } as unknown as ResourceManifest;

    const analyzer = new StaticAnalyzer();
    const diags = analyzer.analyze([...base, knownScript, dispatcher]);
    const unresolved = diags.find((d) => d.code === "UNRESOLVED_REFERENCE");
    expect(unresolved).toBeUndefined();

    // After analyze() runs, the sentinel has been substituted in place.
    expect(dispatcher.handler).toEqual({ kind: "std.Script", name: "DoStuff" });
  });

  it("emits UNRESOLVED_REFERENCE when the sentinel points at a missing name", () => {
    const dispatcher: ResourceManifest = {
      kind: "std.Dispatcher",
      metadata: { name: "Main" },
      handler: makeTaggedSentinel("ref", "NotDeclared"),
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze([...base, dispatcher]);
    const unresolved = diags.find((d) => d.code === "UNRESOLVED_REFERENCE");
    expect(unresolved).toBeDefined();
    expect(unresolved!.message).toContain("NotDeclared");
    expect((unresolved!.data as { path: string }).path).toBe("handler");
  });
});

describe("shared ResourceRef schema fragment wiring", () => {
  /** Proves `telo://manifest#/$defs/ResourceRef` resolves through AJV: a
   *  module schema can `$ref` it and validation runs end-to-end. Without
   *  the `addSchema(ManifestRootSchema)` call inside `createAjv`, AJV
   *  would throw at compile time with an unresolved-ref error — this is
   *  the test that pins the wiring in place. */
  it("AJV resolves $ref to the shared fragment registered under telo://manifest", () => {
    const ajv = createAjv();
    const consumerSchema = {
      type: "object",
      properties: {
        target: { $ref: "telo://manifest#/$defs/ResourceRef" },
      },
      required: ["target"],
    };
    const validate = ajv.compile(consumerSchema);

    // Tagged-sentinel shape: valid
    expect(
      validate({ target: makeTaggedSentinel("ref", "MyResource") }),
    ).toBe(true);

    // Engine other than `ref`: rejected by the fragment's `const: "ref"`
    expect(validate({ target: { __tagged: true, engine: "cel", source: "x" } })).toBe(false);

    // Missing `source`: rejected
    expect(validate({ target: { __tagged: true, engine: "ref" } })).toBe(false);

    // Bare string (legacy form): rejected by the strict fragment — the
    // fragment intentionally describes only the canonical shape; slots
    // that need to accept legacy forms during migration keep their
    // hand-rolled oneOf alongside.
    expect(validate({ target: "MyResource" })).toBe(false);
  });
});
