import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** Run.Sequence-shaped definition in the legacy step-body spelling: `steps`
 *  declares `x-telo-step-context`, and each step's `invoke` is an x-telo-ref
 *  slot in the shared `#/$defs/step`. A named step's inline target is extracted
 *  and checked as a resource of its own; an unnamed step's is left in place, and
 *  that is what this pass checks. `then` mirrors the branch nesting so we can
 *  prove recursion into nested step trees. */
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
            anyOf: [{ "x-telo-ref": "telo#Invocable" }],
          },
          inputs: {
            "x-telo-topology-role": "inputs",
            type: "object",
            additionalProperties: true,
          },
          then: {
            "x-telo-topology-role": "branch",
            type: "array",
            items: { $ref: "#/$defs/step" },
          },
        },
      },
    },
    properties: {
      steps: {
        "x-telo-topology-role": "steps",
        "x-telo-step-context": { invoke: "invoke" },
        type: "array",
        items: { $ref: "#/$defs/step" },
      },
    },
  },
} as unknown as ResourceManifest;

/** Invocable whose runtime input (`prompt`) lives in `inputType`, while its
 *  construction config is closed (`additionalProperties: false`). Putting
 *  `prompt` on the inline invoke object is therefore a config violation. */
const sinkDef = {
  kind: "Telo.Definition",
  metadata: { name: "ReadLine", module: "console" },
  capability: "Telo.Invocable",
  inputType: {
    kind: "Type.JsonSchema",
    schema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  schema: { type: "object", additionalProperties: false },
} as unknown as ResourceManifest;

function schemaViolations(manifests: ResourceManifest[]) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "SCHEMA_VIOLATION");
}

function subject(d: { data?: unknown }) {
  const data = d.data as { resource?: { kind: string; name: string }; path?: string };
  return { resource: data.resource, path: data.path };
}

function aliasedManifests(step: Record<string, unknown>) {
  // `Run` / `Console` are root-scope import aliases; the inline kind
  // `Console.ReadLine` must resolve through `aliases.resolveKind` to
  // `console.ReadLine` before its config is validated.
  const app = { kind: "Telo.Application", metadata: { name: "app" }, targets: [] };
  // `resolvedModuleName` is what the loader stamps once it has read the
  // target's Telo.Library doc. Stated explicitly here because nothing ever
  // derives a module name from the source string — an import with no resolved
  // identity registers no alias at all.
  const runImport = {
    kind: "Telo.Import",
    metadata: { name: "Run", resolvedModuleName: "run" },
    source: "run",
  };
  const consoleImport = {
    kind: "Telo.Import",
    metadata: { name: "Console", resolvedModuleName: "console" },
    source: "console",
  };
  const seq = { kind: "Run.Sequence", metadata: { name: "Loop" }, steps: [step] };
  return [sequenceDef, sinkDef, app, runImport, consoleImport, seq] as unknown as ResourceManifest[];
}

function undefinedKinds(manifests: ResourceManifest[]) {
  return new StaticAnalyzer()
    .analyze(withSyntheticPositions(manifests))
    .filter((d) => d.code === "UNDEFINED_KIND");
}

describe("a named step's inline target, extracted and checked as its own resource", () => {
  it("flags an input placed on the inline invoke instead of inputs", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [{ name: "Read", invoke: { kind: "console.ReadLine", prompt: "you › " } }],
    } as unknown as ResourceManifest;

    const violations = schemaViolations([sequenceDef, sinkDef, seq]);
    expect(violations.length).toBe(1);
    expect(subject(violations[0])).toEqual({
      resource: { kind: "run.Sequence", name: "Loop" },
      path: "steps[0].invoke",
    });
    expect(violations[0].message).toContain("'prompt' is not allowed");
  });

  it("accepts a correct inline step invoke with the input under inputs", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [
        { name: "Read", invoke: { kind: "console.ReadLine" }, inputs: { prompt: "you › " } },
      ],
    } as unknown as ResourceManifest;

    expect(schemaViolations([sequenceDef, sinkDef, seq])).toEqual([]);
  });

  it("reaches nested branch steps", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [
        {
          name: "Outer",
          invoke: { kind: "console.ReadLine" },
          inputs: { prompt: "you › " },
          then: [{ name: "Inner", invoke: { kind: "console.ReadLine", prompt: "nested › " } }],
        },
      ],
    } as unknown as ResourceManifest;

    const violations = schemaViolations([sequenceDef, sinkDef, seq]);
    expect(violations.length).toBe(1);
    expect(subject(violations[0])).toEqual({
      resource: { kind: "run.Sequence", name: "Loop" },
      path: "steps[0].then[0].invoke",
    });
    expect(violations[0].message).toContain("'prompt' is not allowed");
  });

  it("resolves an inline kind written via an import alias", () => {
    const violations = schemaViolations(
      aliasedManifests({ name: "Read", invoke: { kind: "Console.ReadLine", prompt: "you › " } }),
    );
    expect(violations.length).toBe(1);
    expect(subject(violations[0])).toEqual({
      resource: { kind: "Run.Sequence", name: "Loop" },
      path: "steps[0].invoke",
    });
    expect(violations[0].message).toContain("'prompt' is not allowed");
  });

  it("flags an unknown inline kind", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [{ name: "Read", invoke: { kind: "console.Missing" } }],
    } as unknown as ResourceManifest;

    const unknown = undefinedKinds([sequenceDef, sinkDef, seq]);
    expect(unknown.length).toBe(1);
    expect(subject(unknown[0])).toEqual({
      resource: { kind: "run.Sequence", name: "Loop" },
      path: "steps[0].invoke.kind",
    });
    expect(unknown[0].message).toContain("console.Missing");
  });
});

describe("an unnamed step's inline target, left in place for this pass", () => {
  it("flags an input placed on the inline invoke instead of inputs", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [{ invoke: { kind: "console.ReadLine", prompt: "you › " } }],
    } as unknown as ResourceManifest;

    const violations = schemaViolations([sequenceDef, sinkDef, seq]);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("inline console.ReadLine at 'steps[0].invoke'");
    expect(violations[0].message).toContain("'prompt' is not allowed");
  });

  it("recurses into nested branch steps", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [
        {
          name: "Outer",
          invoke: { kind: "console.ReadLine" },
          inputs: { prompt: "you › " },
          then: [{ invoke: { kind: "console.ReadLine", prompt: "nested › " } }],
        },
      ],
    } as unknown as ResourceManifest;

    const violations = schemaViolations([sequenceDef, sinkDef, seq]);
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("'steps[0].then[0].invoke'");
    expect(violations[0].message).toContain("'prompt' is not allowed");
  });

  it("resolves an inline kind written via an import alias", () => {
    const violations = schemaViolations(
      aliasedManifests({ invoke: { kind: "Console.ReadLine", prompt: "you › " } }),
    );
    expect(violations.length).toBe(1);
    expect(violations[0].message).toContain("inline Console.ReadLine at 'steps[0].invoke'");
    expect(violations[0].message).toContain("'prompt' is not allowed");
  });

  it("flags an unknown inline kind that no other pass can see", () => {
    const seq = {
      kind: "run.Sequence",
      metadata: { name: "Loop", module: "test" },
      steps: [{ invoke: { kind: "console.Missing" } }],
    } as unknown as ResourceManifest;

    const unknown = undefinedKinds([sequenceDef, sinkDef, seq]);
    expect(unknown.length).toBe(1);
    expect(unknown[0].message).toContain("console.Missing");
    expect((unknown[0].data as { path?: string }).path).toBe("steps[0].invoke.kind");
  });
});

describe("an inline declaration behind a local $ref, outside any step body", () => {
  it("is extracted and schema-checked, anchored at the path its author wrote", () => {
    const holderDef = {
      kind: "Telo.Definition",
      metadata: { name: "Holder", module: "run" },
      capability: "Telo.Invocable",
      schema: {
        type: "object",
        properties: { target: { $ref: "#/$defs/Target" } },
        $defs: { Target: { "x-telo-ref": { kind: "console.ReadLine", use: "call" } } },
      },
    } as unknown as ResourceManifest;
    const holder = {
      kind: "run.Holder",
      metadata: { name: "holder", module: "test" },
      target: { kind: "console.ReadLine", prompt: "you › " },
    } as unknown as ResourceManifest;
    const violations = schemaViolations([holderDef, sinkDef, holder]);
    expect(violations.map((d) => (d.data as { path?: string }).path)).toEqual(["target"]);
  });
});
