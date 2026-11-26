import { describe, expect, it } from "vitest";
import { capabilitiesAt, runnerTitle } from "./runner-title";

describe("runnerTitle", () => {
  it("keeps a stored name that is not the adapter's label", () => {
    expect(runnerTitle("Development runner", "Docker runner", "Docker runner")).toBe("Development runner");
  });
  it("prefers the advertised name over the adapter's label", () => {
    expect(runnerTitle("Docker runner", "Telo Runner", "Docker runner")).toBe("Telo Runner");
  });
  it("falls back to the adapter's label when nothing is advertised", () => {
    expect(runnerTitle("Docker runner", undefined, "Docker runner")).toBe("Docker runner");
  });
});

describe("the name a newly added runner is saved with", () => {
  const local = { url: "http://runner.telo.localhost:8060", caps: { displayName: "Docker runner" } };

  it("never takes the name another address advertised", () => {
    const caps = capabilitiesAt("https://runner.telo.run", local);
    expect(runnerTitle(undefined, caps?.displayName, "HTTP runner")).toBe("HTTP runner");
  });
  it("takes the name its own address advertised", () => {
    const own = { url: "https://runner.telo.run", caps: { displayName: "Telo Runner" } };
    expect(runnerTitle(undefined, capabilitiesAt(own.url, own)?.displayName, "HTTP runner")).toBe("Telo Runner");
  });
});
