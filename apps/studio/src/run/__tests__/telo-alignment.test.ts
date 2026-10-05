import { describe, expect, it } from "vitest";

import { describeTeloAlignment, staleRunVersion, teloAlignment } from "../telo-alignment";

describe("teloAlignment", () => {
  it("confirms a runtime reporting the version asked for", () => {
    expect(teloAlignment("0.80.0", "0.80.0")).toEqual({ kind: "confirmed", version: "0.80.0" });
  });

  it("reports a runtime on another version, naming both", () => {
    const alignment = teloAlignment("0.80.0", "0.81.0");
    expect(alignment).toEqual({ kind: "mismatch", requested: "0.80.0", reported: "0.81.0" });
    expect(describeTeloAlignment(alignment!)).toMatch(/edited against telo 0\.80\.0.*reports telo 0\.81\.0/);
  });

  it("tells an unreleased build from the release of the same number", () => {
    expect(teloAlignment("0.80.0+unreleased", "0.80.0")?.kind).toBe("mismatch");
  });

  it("leaves a runtime that reports nothing unconfirmed, not mismatched", () => {
    expect(teloAlignment("0.80.0", undefined)).toEqual({ kind: "unconfirmed", requested: "0.80.0" });
  });

  it("says what a runner that aligns nothing chose, and nothing when that is unknown too", () => {
    expect(teloAlignment(undefined, "0.81.0")).toEqual({ kind: "runner-chosen", version: "0.81.0" });
    expect(teloAlignment(undefined, undefined)).toBeNull();
  });
});

describe("staleRunVersion", () => {
  it("reports a live run whose module moved to another version", () => {
    expect(staleRunVersion("running", "0.80.0", "0.81.0")).toEqual({ running: "0.80.0", edited: "0.81.0" });
    expect(staleRunVersion("suspended", "0.80.0", "0.81.0")).not.toBeNull();
  });

  it("says nothing while the two agree, or while the module has no version", () => {
    expect(staleRunVersion("running", "0.80.0", "0.80.0")).toBeNull();
    expect(staleRunVersion("running", "0.80.0", undefined)).toBeNull();
  });

  it("says nothing of a finished run, or of one that asked for no version", () => {
    expect(staleRunVersion("exited", "0.80.0", "0.81.0")).toBeNull();
    expect(staleRunVersion("running", undefined, "0.81.0")).toBeNull();
  });
});
