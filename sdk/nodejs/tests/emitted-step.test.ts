import { describe, expect, it } from "vitest";
import { isCelMap } from "../src/cel-value-identity.js";
import { fileStepResult, stepJournalPath, stepLabel } from "../src/emitted-step.js";
import {
  StepEngine,
  type DurableRunHandle,
  type InvokeContext,
  type Step,
  type StepEngineContext,
} from "../src/index.js";

describe("a step a template repeat emitted", () => {
  it("is journaled under its repeat and its key, a string key a CEL literal with CEL escapes", () => {
    expect(stepJournalPath("steps", { __emitted: { repeat: "runs", key: "nightlyReport" } })).toBe(
      "steps/runs['nightlyReport']",
    );
    expect(stepJournalPath("steps", { __emitted: { repeat: "runs", key: 0 } })).toBe("steps/runs[0]");
    expect(stepJournalPath("steps", { __emitted: { repeat: "runs", key: "a'b/c" } })).toBe(
      "steps/runs['a\\'b/c']",
    );
    expect(stepJournalPath("steps", { __emitted: { site: "steps_1_emit", keys: ["t", 2] } })).toBe(
      "steps/steps_1_emit['t'][2]",
    );
    expect(stepJournalPath("steps", { name: "plain" })).toBe("steps/plain");
    expect(stepJournalPath("steps", {})).toBeUndefined();
    expect(stepLabel({ __emitted: { repeat: "runs", key: "a" } })).toBe("runs['a']");
  });

  it("files a named repeat's results as a map by key, and an unnamed one's nowhere", () => {
    const steps: Record<string, unknown> = {};
    fileStepResult(steps, { __emitted: { repeat: "runs", key: "a" } }, 1);
    fileStepResult(steps, { __emitted: { repeat: "runs", key: "b" } }, 2);
    fileStepResult(steps, { __emitted: { site: "steps_0_emit", keys: ["a"] } }, 3);
    expect({ ...(steps.runs as object) }).toEqual({ a: { result: 1 }, b: { result: 2 } });
    expect(Object.keys(steps)).toEqual(["runs"]);

    fileStepResult(steps, { __emitted: { repeat: "listed", key: 0 } }, "x");
    fileStepResult(steps, { __emitted: { repeat: "listed", key: 1 } }, "y");
    const listed = steps.listed;
    expect(isCelMap(listed)).toBe(true);
    if (!isCelMap(listed)) return;
    expect([...listed.entries.values()].map(({ key, value }) => [key, value])).toEqual([
      [0n, { result: "x" }],
      [1n, { result: "y" }],
    ]);
  });
});

describe("a named repeat's steps in a durable run", () => {
  it("replay by key: recorded elements answer from the journal, an element inserted among them executes", async () => {
    const recorded: Record<string, unknown> = {
      "steps/runs['a']": "recorded-a",
      "steps/runs['b']": "recorded-b",
    };
    const computed: string[] = [];
    const ctx = {
      expandValue: (value: unknown) => {
        computed.push(String(value));
        return value;
      },
    } as unknown as StepEngineContext;
    const durable = {
      runId: "run-1",
      decide: async (path: string, kind: string, compute: () => unknown) =>
        path in recorded ? recorded[path] : compute(),
    } as unknown as DurableRunHandle;
    const body = ["a", "x", "b"].map((key) => ({
      __emitted: { repeat: "runs", key },
      value: `fresh-${key}`,
    })) as unknown as Step[];
    const steps: Record<string, unknown> = {};

    await new StepEngine(ctx, { kind: "Sequence", resourceName: "body" }).executeSteps(
      body,
      steps,
      undefined,
      {},
      { durable } as InvokeContext,
    );

    expect(computed).toEqual(["fresh-x"]);
    expect({ ...(steps.runs as object) }).toEqual({
      a: { result: "recorded-a" },
      x: { result: "fresh-x" },
      b: { result: "recorded-b" },
    });
  });
});
