import { describe, expect, it } from "vitest";
import {
  inlineStepTargetName,
  StepEngine,
  type KindRef,
  type Step,
  type StepEngineContext,
} from "../src/index.js";

/** A host for a body assembled in code. `ensureKindRef` follows the kernel's
 *  rule: an inline declaration is registered under the name it is handed, a
 *  named reference is returned as it is and registers nothing. */
function recordingContext() {
  const registered: { kind: string; name: string | undefined }[] = [];
  const ctx = {
    expandValue: (value: unknown) => value,
    invoke: async () => {
      throw new Error("unused: nothing is dispatched here");
    },
    invokeResolved: async () => {
      throw new Error("unused: nothing is dispatched here");
    },
    ensureKindRef(value: { kind: string; name?: string }, resourceName?: string): KindRef {
      if (typeof value.name === "string") return { kind: value.kind, name: value.name } as KindRef;
      registered.push({ kind: value.kind, name: resourceName });
      return { kind: value.kind, name: resourceName } as KindRef;
    },
  } as unknown as StepEngineContext;
  return { ctx, registered };
}

const inline = (value: number) => ({ kind: "Run.Value", value });

describe("StepEngine.resolveInvokes — a body assembled in code", () => {
  it("names every inline target through the shared rule, at every nesting form", () => {
    const { ctx, registered } = recordingContext();
    const owner = { kind: "Sequence", resourceName: "built" };
    const steps = [
      { name: "first", invoke: inline(1) },
      {
        name: "branch",
        if: "true",
        then: [{ name: "taken", invoke: inline(2) }],
        elseif: [{ if: "false", then: [{ name: "alternative", invoke: inline(3) }] }],
        else: [{ name: "otherwise", invoke: inline(4) }],
      },
      {
        name: "pick",
        switch: "'a'",
        cases: { a: [{ name: "caseA", invoke: inline(5) }] },
        default: [{ name: "fallback", invoke: inline(6) }],
      },
      {
        name: "guard",
        try: [{ name: "attempt", invoke: inline(7) }],
        catch: [{ name: "recover", invoke: inline(8) }],
        finally: [{ name: "cleanup", invoke: inline(9) }],
      },
      { name: "repeat", while: "false", do: [{ name: "body", invoke: inline(10) }] },
    ] as unknown as Step[];

    new StepEngine(ctx, owner).resolveInvokes(steps);

    expect(registered.map((r) => r.name)).toEqual([
      "SequenceBuiltSteps0First",
      "SequenceBuiltSteps1Then0Taken",
      "SequenceBuiltSteps1Elseif0Then0Alternative",
      "SequenceBuiltSteps1Else0Otherwise",
      "SequenceBuiltSteps2CasesA0CaseA",
      "SequenceBuiltSteps2Default0Fallback",
      "SequenceBuiltSteps3Try0Attempt",
      "SequenceBuiltSteps3Catch0Recover",
      "SequenceBuiltSteps3Finally0Cleanup",
      "SequenceBuiltSteps4Do0Body",
    ]);
    expect(registered[1].name).toBe(
      inlineStepTargetName(owner, ["steps", "1", "then", "0"], "taken"),
    );
    // The step now holds the reference, not the declaration.
    expect((steps[0] as { invoke: unknown }).invoke).toEqual({
      kind: "Run.Value",
      name: "SequenceBuiltSteps0First",
    });
  });

  it("leaves a named reference as it is and registers nothing", () => {
    const { ctx, registered } = recordingContext();
    const steps = [
      { name: "call", invoke: { kind: "Run.Value", name: "SequenceSeqSteps0Call" } },
    ] as unknown as Step[];

    new StepEngine(ctx, { kind: "Sequence", resourceName: "seq" }).resolveInvokes(steps);

    expect(registered).toEqual([]);
    expect((steps[0] as { invoke: unknown }).invoke).toEqual({
      kind: "Run.Value",
      name: "SequenceSeqSteps0Call",
    });
  });
});

describe("inlineStepTargetName", () => {
  it("does not depend on where a caller split the path at punctuation", () => {
    const owner = { kind: "Sequence", resourceName: "my-seq" };
    const split = inlineStepTargetName(owner, ["steps", "0", "cases", "v1", "0", "0"], "do it");
    const whole = inlineStepTargetName(owner, ["steps", "0", "cases", "v1.0", "0"], "do it");
    expect(split).toBe("SequenceMySeqSteps0CasesV100DoIt");
    expect(whole).toBe(split);
  });
});
