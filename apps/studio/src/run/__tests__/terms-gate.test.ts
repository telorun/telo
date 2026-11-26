import { describe, expect, it } from "vitest";
import { termsGateToShow } from "../terms-gate";

const terms = { version: "1", title: "Terms", body: "b" } as never;
const session = (runnerId: string, phase = "terms") => ({ phase, terms, runnerId });

describe("termsGateToShow", () => {
  it("asks for the active runner's own session", () => {
    expect(termsGateToShow({ session: session("hosted"), activeRunnerId: "hosted", declinedRunnerId: null })).toBe(terms);
  });
  it("drops the terms of a runner that is no longer active", () => {
    expect(termsGateToShow({ session: session("hosted"), activeRunnerId: "docker", declinedRunnerId: null })).toBeNull();
  });
  it("does not ask again for a runner the user declined", () => {
    expect(termsGateToShow({ session: session("hosted"), activeRunnerId: "hosted", declinedRunnerId: "hosted" })).toBeNull();
  });
  it("asks nothing outside the terms phase", () => {
    expect(termsGateToShow({ session: session("hosted", "live"), activeRunnerId: "hosted", declinedRunnerId: null })).toBeNull();
  });
});
