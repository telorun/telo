import { describe, expect, it } from "vitest";

import { FAILURE_OUTPUT_CHARS, FAILURE_OUTPUT_LINES, describeRunFailure, outputTail } from "../run-failure";

describe("a run's failure, as the dock shows it", () => {
  it("is the run's failed start, non-zero exit or signal, and its application's failed latest generation", () => {
    expect(describeRunFailure({ status: { kind: "failed", message: "image pull failed" }, runs: {} })).toEqual([
      "Run failed: image pull failed",
    ]);
    expect(describeRunFailure({ status: { kind: "exited", code: 2 }, runs: {} })).toEqual(["Exited with code 2"]);
    expect(describeRunFailure({ status: { kind: "signalled", signal: "SIGKILL" }, runs: {} })).toEqual([
      "Ended by signal SIGKILL",
    ]);
    expect(
      describeRunFailure({
        status: { kind: "running" },
        runs: {
          api: { type: "run", app: "api", generation: 3, phase: "failed", reason: "ERR_RESOURCE_INIT" },
          job: { type: "run", app: "job", generation: 1, phase: "completed", code: 1 },
        },
      }),
    ).toEqual(["api (run #3) failed: ERR_RESOURCE_INIT", "job (run #1) exited with code 1"]);
  });

  it("is absent from a run that is up, or ended cleanly", () => {
    expect(describeRunFailure({ status: { kind: "exited", code: 0 }, runs: {} })).toBeNull();
    expect(
      describeRunFailure({
        status: { kind: "running" },
        runs: { api: { type: "run", app: "api", generation: 1, phase: "started", trigger: "run" } },
      }),
    ).toBeNull();
  });
});

describe("the output that goes with a failure", () => {
  it("is the last lines as plain text, bounded in lines and characters", () => {
    expect(outputTail("\x1b[31mboom\x1b[0m\r\nat line 3\r\n")).toBe("boom\nat line 3");
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    expect(outputTail(many)?.split("\n")).toHaveLength(FAILURE_OUTPUT_LINES);
    expect(outputTail(many)?.endsWith("line 99")).toBe(true);
    expect(outputTail("x".repeat(FAILURE_OUTPUT_CHARS * 2))).toHaveLength(FAILURE_OUTPUT_CHARS);
    expect(outputTail("\n \n")).toBeNull();
  });
});
