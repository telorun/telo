import { describe, expect, it } from "vitest";
import { celTimestamp } from "../src/cel-value-identity.js";
import { readRecordedValue, RECORDED_VALUE_CODEC_VERSION } from "../src/recorded-value.js";

describe("a recorded value", () => {
  const stamp = '{"$telo":"google.protobuf.Timestamp","value":';

  it("reads an entry under the codec version that wrote it", () => {
    // Version 1 wrote an instant with exactly three fractional digits. An entry a
    // journal already holds is read as its writer meant it — a run parked before this
    // change resumes rather than being stranded — while the same text under the current
    // version is refused for not being canonical there.
    expect(readRecordedValue("run-1", "steps/at", 1, `${stamp}"2026-01-15T07:30:00.000Z"}`)).toEqual({
      value: celTimestamp(1768462200n, 0),
    });
    expect(() =>
      readRecordedValue("run-1", "steps/at", RECORDED_VALUE_CODEC_VERSION, `${stamp}"2026-01-15T07:30:00.000Z"}`),
    ).toThrow(/ERR_DURABLE_JOURNAL_CORRUPT|not RFC 3339/);
    expect(
      readRecordedValue("run-1", "steps/at", RECORDED_VALUE_CODEC_VERSION, `${stamp}"2026-01-15T07:30:00.000000001Z"}`),
    ).toEqual({ value: celTimestamp(1768462200n, 1) });
  });

  it("refuses a version it does not read, naming the ones it does", () => {
    let thrown: unknown;
    try {
      readRecordedValue("run-1", "steps/at", 99, `${stamp}"2026-01-15T07:30:00Z"}`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "ERR_DURABLE_ENTRY_UNDECODABLE",
      data: { run: "run-1", path: "steps/at", version: 99, reads: [1, 2] },
    });
  });

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
