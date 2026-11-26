import { describe, expect, it } from "vitest";
import { programEnd } from "./program-end";

const base = { status: { kind: "running" } as const, app: "hello", outcomeAt: { hello: 5000 } };

describe("programEnd", () => {
  it("is finished for exit 0 under a live run", () => {
    expect(
      programEnd({ ...base, runs: { hello: { type: "run", app: "hello", generation: 1, phase: "completed", code: 0 } } }),
    ).toEqual({
      outcome: "finished",
      endedAt: 5000,
      detail: "Exited with code 0 — watching for changes; edits run it again",
    });
  });

  it("is failed for a non-zero exit", () => {
    const end = programEnd({
      ...base,
      runs: { hello: { type: "run", app: "hello", generation: 1, phase: "completed", code: 2 } },
    });
    expect(end?.outcome).toBe("failed");
  });

  it("is null while a generation runs, and again once an edit restarts it", () => {
    const started = { type: "run", app: "hello", generation: 2, phase: "started", trigger: "watch" } as const;
    expect(programEnd({ ...base, runs: { hello: started } })).toBeNull();
  });

  it("is null for a run that is over", () => {
    expect(
      programEnd({
        ...base,
        status: { kind: "exited", code: 0 },
        runs: { hello: { type: "run", app: "hello", generation: 1, phase: "completed", code: 0 } },
      }),
    ).toBeNull();
  });
});
