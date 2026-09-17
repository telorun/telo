import { describe, expect, it } from "vitest";
import { readRecordedValue, RECORDED_VALUE_CODEC_VERSION } from "../src/recorded-value.js";

describe("a recorded value", () => {
  it("reports a frame that does not decode as a corrupt journal, naming the run and the path", () => {
    let thrown: unknown;
    try {
      readRecordedValue("run-1", "steps/charge", RECORDED_VALUE_CODEC_VERSION, '{"$telo":"nope","value":"x"}');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "ERR_DURABLE_JOURNAL_CORRUPT",
      data: { run: "run-1", path: "steps/charge" },
      cause: expect.objectContaining({ code: "ERR_TYPED_FRAME_UNDECODABLE" }),
    });
  });
});
