import { inlineStepTargetName, type ResourceDefinition, type ResourceManifest } from "@telorun/sdk";
import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { DefinitionRegistry } from "../src/definition-registry.js";
import { expandManifestFragments, MANIFEST_SCHEMA_URI } from "../src/manifest-schemas.js";
import { normalizeInlineResources } from "../src/normalize-inline-resources.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

/** A kind whose body is the shared step grammar, exactly as a module writes it. */
function definition(
  name: string,
  schema: Record<string, any>,
  extra: Record<string, unknown> = {},
): ResourceManifest {
  const doc = {
    kind: "Telo.Definition",
    metadata: { name, module: "demo" },
    capability: "Telo.Runnable",
    schema,
    ...extra,
  };
  expandManifestFragments(doc);
  return doc as unknown as ResourceManifest;
}

const stepBody = { type: "array", items: { $ref: `${MANIFEST_SCHEMA_URI}#/$defs/Step` } };

const sequenceDef = definition(
  "Sequence",
  {
    type: "object",
    properties: {
      with: { "x-telo-scope": ["/steps", "/targets"] },
      targets: { type: "array", items: { "x-telo-ref": { kind: "demo.Task", use: "call" } } },
      steps: stepBody,
    },
  },
  { controllers: ["pkg:npm/@demo/run@1.0.0"] },
);
/** Inherits Sequence's controller and, without `base:`, its step body. */
const pipelineDef = definition("Pipeline", { type: "object", properties: {} }, {
  extends: "demo.Sequence",
});
/** Inherits Sequence's controller through `base:`, from a body of its own. */
const stagedDef = definition("Staged", { type: "object", properties: { stages: stepBody } }, {
  extends: "demo.Sequence",
  base: { steps: makeTaggedSentinel("cel", "self.stages") },
});
/** Reshapes its body on the way to the parent, so nothing can say what the
 *  controller will read it as. */
const filteredDef = definition("Filtered", { type: "object", properties: { stages: stepBody } }, {
  extends: "demo.Sequence",
  base: { steps: makeTaggedSentinel("cel", "self.stages.filter(s, true)") },
});
const taskDef = definition(
  "Task",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      value: {},
      helper: { "x-telo-ref": { kind: "demo.Task", use: "call" } },
    },
  },
  { capability: "Telo.Invocable" },
);

const DEFINITIONS = [sequenceDef, pipelineDef, stagedDef, filteredDef, taskDef];

function registry(): DefinitionRegistry {
  const r = new DefinitionRegistry();
  for (const def of DEFINITIONS) r.register(def as unknown as ResourceDefinition);
  return r;
}

const named = (manifests: ResourceManifest[], name: string) =>
  manifests.find((m) => m.metadata?.name === name) as Record<string, any> | undefined;

const task = (config: Record<string, unknown> = {}) => ({ kind: "demo.Task", ...config });

describe("inline step targets are extracted at load", () => {
  it("extracts a target at every nesting form, under the step engine's own name", () => {
    const seq = {
      kind: "demo.Sequence",
      metadata: { name: "seq", module: "demo" },
      steps: [
        { name: "first", invoke: task({ helper: task({ value: 2 }) }) },
        {
          name: "branch",
          if: true,
          then: [{ name: "taken", invoke: task() }],
          elseif: [{ if: false, then: [{ name: "alternative", invoke: task() }] }],
          else: [{ name: "otherwise", invoke: task() }],
        },
        {
          name: "pick",
          switch: "a",
          cases: { "v1.0": [{ name: "caseA", invoke: task() }] },
          default: [{ name: "fallback", invoke: task() }],
        },
        {
          name: "guard",
          try: [{ name: "attempt", invoke: task() }],
          catch: [{ name: "recover", invoke: task() }],
          finally: [{ name: "cleanup", invoke: task() }],
        },
        { name: "repeat", while: false, do: [{ name: "body", invoke: task() }] },
      ],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([seq], registry());
    const owner = { kind: "Sequence", resourceName: "seq" };
    const expected: Array<[string[], string, string]> = [
      [["steps", "0"], "first", "steps[0].invoke"],
      [["steps", "1", "then", "0"], "taken", "steps[1].then[0].invoke"],
      [["steps", "1", "elseif", "0", "then", "0"], "alternative", "steps[1].elseif[0].then[0].invoke"],
      [["steps", "1", "else", "0"], "otherwise", "steps[1].else[0].invoke"],
      [["steps", "2", "cases", "v1.0", "0"], "caseA", "steps[2].cases.v1.0[0].invoke"],
      [["steps", "2", "default", "0"], "fallback", "steps[2].default[0].invoke"],
      [["steps", "3", "try", "0"], "attempt", "steps[3].try[0].invoke"],
      [["steps", "3", "catch", "0"], "recover", "steps[3].catch[0].invoke"],
      [["steps", "3", "finally", "0"], "cleanup", "steps[3].finally[0].invoke"],
      [["steps", "4", "do", "0"], "body", "steps[4].do[0].invoke"],
    ];
    for (const [path, step, pathFromParent] of expected) {
      const name = inlineStepTargetName(owner, path, step);
      const extracted = named(out, name);
      expect(extracted, name).toBeDefined();
      expect(extracted!.metadata.xTeloOrigin).toEqual({
        parentKind: "demo.Sequence",
        parentName: "seq",
        pathFromParent,
        stepTarget: true,
      });
      expect(extracted!.metadata.module).toBe("demo");
    }
    expect(named(out, "SequenceSeqSteps2CasesV100CaseA")).toBeDefined();

    // The step holds the reference now, not the declaration.
    const clone = named(out, "seq")!;
    expect(clone.steps[1].then[0].invoke).toEqual({
      kind: "demo.Task",
      name: "SequenceSeqSteps1Then0Taken",
    });

    // What the target itself declares inline is extracted in turn, as an
    // ordinary reference slot of the extracted declaration.
    const first = named(out, "SequenceSeqSteps0First")!;
    expect(first.helper).toEqual({ kind: "demo.Task", name: "SequenceSeqSteps0First_helper" });
    expect(named(out, "SequenceSeqSteps0First_helper")!.metadata.xTeloOrigin).toEqual({
      parentKind: "demo.Task",
      parentName: "SequenceSeqSteps0First",
      pathFromParent: "helper",
    });

    // The caller's manifests are never touched.
    expect((seq as Record<string, any>).steps[0].invoke.kind).toBe("demo.Task");
    expect((seq as Record<string, any>).steps[0].invoke.name).toBeUndefined();
  });

  it("names a target after the controller that runs the body, for a child that inherits it", () => {
    const pipe = {
      kind: "demo.Pipeline",
      metadata: { name: "pipe", module: "demo" },
      steps: [{ name: "first", invoke: task() }],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([pipe], registry());
    expect(named(out, "SequencePipeSteps0First")).toBeDefined();
  });

  it("names a base-form child's body after the parent field `base:` maps it onto", () => {
    // The inherited controller reads `steps`, so that is what it named the
    // targets under at run time — not the child's own `stages`.
    const staged = {
      kind: "demo.Staged",
      metadata: { name: "st", module: "demo" },
      stages: [{ name: "first", invoke: task() }],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([staged], registry());
    expect(named(out, "SequenceStSteps0First")).toBeDefined();
    expect(named(out, "SequenceStStages0First")).toBeUndefined();
  });

  it("leaves a body that base: reshapes for the runtime to name, as it always has", () => {
    const filtered = {
      kind: "demo.Filtered",
      metadata: { name: "fl", module: "demo" },
      stages: [{ name: "first", invoke: task({ value: 1 }) }],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([filtered], registry());
    expect(named(out, "fl")!.stages[0].invoke).toEqual({ kind: "demo.Task", value: 1 });
    expect(out).toHaveLength(1);
  });

  it("marks what it extracts out of a dependency's forwarded export as that dependency's code", () => {
    const moduleGlobals = { variables: { greeting: { type: "string" } } };
    const probe = {
      kind: "demo.Sequence",
      metadata: { name: "probe", module: "lib", forwardedExport: true, moduleGlobals },
      steps: [{ name: "first", invoke: task({ helper: task() }) }],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([probe], registry());
    for (const name of ["SequenceProbeSteps0First", "SequenceProbeSteps0First_helper"]) {
      const meta = named(out, name)!.metadata;
      expect(meta.forwardedInternal, name).toBe(true);
      // Internal, never an export: nothing may count it as one.
      expect(meta.forwardedExport, name).toBeUndefined();
      expect(meta.module, name).toBe("lib");
      expect(meta.moduleGlobals, name).toEqual(moduleGlobals);
    }
  });

  it("creates an inline `targets:` entry in the scope that runs it", () => {
    const outer = {
      kind: "demo.Sequence",
      metadata: { name: "outer", module: "demo" },
      with: [{ kind: "demo.Task", metadata: { name: "v" } }],
      targets: [task({ value: 1 })],
      steps: [],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([outer], registry());
    const clone = named(out, "outer")!;
    expect(clone.targets[0]).toEqual({ kind: "demo.Task", name: "outer_targets_0" });
    expect(clone.with.map((m: Record<string, any>) => m.metadata.name)).toEqual(["v", "outer_targets_0"]);
    expect(named(out, "outer_targets_0")).toBeUndefined();
    // Created in the scope, so its names are in reach.
    expect(clone.with[1].metadata.xTeloOrigin.outsideScopes).toBeUndefined();
  });

  it("keeps a target's own metadata.name, as the runtime always has", () => {
    const seq = {
      kind: "demo.Sequence",
      metadata: { name: "seq", module: "demo" },
      steps: [{ name: "first", invoke: { ...task(), metadata: { name: "chosen" } } }],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([seq], registry());
    expect(named(out, "seq")!.steps[0].invoke).toEqual({ kind: "demo.Task", name: "chosen" });
    expect(named(out, "chosen")).toBeDefined();
  });

  it("creates what a scope member declares inline in that scope, and a scope owner's own targets where it is", () => {
    const outer = {
      kind: "demo.Sequence",
      metadata: { name: "outer", module: "demo" },
      with: [
        {
          kind: "demo.Sequence",
          metadata: { name: "inner" },
          steps: [{ name: "work", invoke: task({ helper: task() }) }],
        },
      ],
      steps: [{ name: "own", invoke: task() }],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([outer], registry());
    const clone = named(out, "outer")!;
    const scoped = clone.with.map((m: Record<string, any>) => m.metadata.name);
    expect(scoped).toEqual(["inner", "SequenceInnerSteps0Work", "SequenceInnerSteps0Work_helper"]);
    expect(named(out, "SequenceInnerSteps0Work")).toBeUndefined();
    // The scope member carries no module of its own; the owner's travels with it.
    expect(clone.with[1].metadata.module).toBe("demo");
    expect(clone.with[2].metadata.module).toBe("demo");

    // The owner's own step target stays where the owner is — never in its own
    // `with:`, which would make it a scoped resource — and records the scope it
    // is written inside and cannot reach.
    const own = named(out, "SequenceOuterSteps0Own")!;
    expect(own).toBeDefined();
    expect(scoped).not.toContain("SequenceOuterSteps0Own");
    expect(own.metadata.xTeloOrigin.outsideScopes).toEqual([
      { ownerKind: "demo.Sequence", ownerName: "outer", field: "with", names: ["inner"] },
    ]);
  });

  it("leaves a step with no name as written and reports it, rather than naming nothing", () => {
    const seq = {
      kind: "demo.Sequence",
      metadata: { name: "seq" },
      steps: [{ invoke: task({ value: 1 }) }],
    } as unknown as ResourceManifest;

    const out = normalizeInlineResources([seq], registry());
    expect(named(out, "seq")!.steps[0].invoke).toEqual({ kind: "demo.Task", value: 1 });

    const diags = new StaticAnalyzer().analyze(withSyntheticPositions([...DEFINITIONS, seq]));
    const missingName = diags.filter(
      (d) =>
        d.code === "SCHEMA_VIOLATION" &&
        d.message.includes("/steps/0 is missing required property 'name'"),
    );
    expect(missingName).toHaveLength(1);
    expect(missingName[0].data).toMatchObject({ resource: { kind: "demo.Sequence", name: "seq" } });
  });
});

describe("diagnostics about an extracted step target", () => {
  it("anchor at the inline position in the author's document", () => {
    const seq = {
      kind: "demo.Sequence",
      metadata: { name: "seq" },
      steps: [{ name: "first", invoke: task({ bogus: 1 }) }],
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer()
      .analyze(withSyntheticPositions([...DEFINITIONS, seq]))
      .filter((d) => d.code === "SCHEMA_VIOLATION");
    expect(diags).toHaveLength(1);
    expect(diags[0].data).toMatchObject({ resource: { kind: "demo.Sequence", name: "seq" } });
    expect((diags[0].data as { path: string }).path.startsWith("steps[0].invoke")).toBe(true);
  });

  it("reports a reference to a scoped name the declaration cannot reach, once, at the reference", () => {
    const outer = {
      kind: "demo.Sequence",
      metadata: { name: "outer" },
      with: [{ kind: "demo.Task", metadata: { name: "observer" } }],
      steps: [
        { name: "call", invoke: task({ helper: makeTaggedSentinel("ref", "observer") }) },
      ],
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze(withSyntheticPositions([...DEFINITIONS, outer]));
    const reach = diags.filter((d) => d.code === "SCOPED_NAME_OUT_OF_REACH");
    expect(reach).toHaveLength(1);
    expect(reach[0].message).toContain("'observer' is declared in 'with:'");
    expect(reach[0].data).toMatchObject({
      resource: { kind: "demo.Sequence", name: "outer" },
      path: "steps[0].invoke.helper",
    });
    expect(diags.filter((d) => d.code === "UNRESOLVED_REFERENCE")).toEqual([]);
  });

  it("reports the CEL spelling of the same reference", () => {
    const outer = {
      kind: "demo.Sequence",
      metadata: { name: "outer" },
      with: [{ kind: "demo.Task", metadata: { name: "observer" } }],
      steps: [
        { name: "call", invoke: task({ value: makeTaggedSentinel("cel", "resources.observer.x") }) },
      ],
    } as unknown as ResourceManifest;

    const reach = new StaticAnalyzer()
      .analyze(withSyntheticPositions([...DEFINITIONS, outer]))
      .filter((d) => d.code === "SCOPED_NAME_OUT_OF_REACH");
    expect(reach).toHaveLength(1);
    expect(reach[0].data).toMatchObject({
      resource: { kind: "demo.Sequence", name: "outer" },
      path: "steps[0].invoke.value",
    });
  });

  it("reads an object that only LOOKS like a reference as the data it is", () => {
    // `value` is no reference slot, so `{kind, name}` there names nothing.
    const outer = {
      kind: "demo.Sequence",
      metadata: { name: "outer" },
      with: [{ kind: "demo.Task", metadata: { name: "observer" } }],
      steps: [{ name: "call", invoke: task({ value: { kind: "Thing", name: "observer" } }) }],
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze(withSyntheticPositions([...DEFINITIONS, outer]));
    expect(diags.filter((d) => d.code === "SCOPED_NAME_OUT_OF_REACH")).toEqual([]);
  });

  it("does not report a name the declaration's own scope declares again", () => {
    const outer = {
      kind: "demo.Sequence",
      metadata: { name: "outer" },
      with: [{ kind: "demo.Task", metadata: { name: "observer" } }],
      steps: [
        {
          name: "call",
          invoke: {
            kind: "demo.Sequence",
            with: [{ kind: "demo.Task", metadata: { name: "observer" } }],
            steps: [{ name: "inner", invoke: makeTaggedSentinel("ref", "observer") }],
          },
        },
      ],
    } as unknown as ResourceManifest;

    const diags = new StaticAnalyzer().analyze(withSyntheticPositions([...DEFINITIONS, outer]));
    expect(diags.filter((d) => d.code === "SCOPED_NAME_OUT_OF_REACH")).toEqual([]);
  });

  it("unfolds a scope-array position the author never wrote into the one they did", () => {
    // `inner` is a scope member with a scope of its own. Its step target is
    // created in `outer`'s scope, where `hidden` — declared by `inner`'s — is out
    // of reach; the reported path must name `inner`'s step, not the array slot
    // the extraction landed in.
    const outer = {
      kind: "demo.Sequence",
      metadata: { name: "outer" },
      with: [
        {
          kind: "demo.Sequence",
          metadata: { name: "inner" },
          with: [{ kind: "demo.Task", metadata: { name: "hidden" } }],
          steps: [{ name: "work", invoke: task({ helper: makeTaggedSentinel("ref", "hidden") }) }],
        },
      ],
      steps: [{ name: "done", invoke: task() }],
    } as unknown as ResourceManifest;

    const reach = new StaticAnalyzer()
      .analyze(withSyntheticPositions([...DEFINITIONS, outer]))
      .filter((d) => d.code === "SCOPED_NAME_OUT_OF_REACH");
    expect(reach).toHaveLength(1);
    expect(reach[0].data).toMatchObject({
      resource: { kind: "demo.Sequence", name: "outer" },
      path: "with[0].steps[0].invoke.helper",
    });
  });
});
