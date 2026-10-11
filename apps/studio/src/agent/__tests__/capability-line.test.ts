import { describe, expect, it } from "vitest";

import { capabilityLine } from "../capability-line";
import type { AgentIdentity } from "../types";

const known = (over: Partial<AgentIdentity>) => ({
  state: "known" as const,
  identity: { name: "AuthoringAgent", version: "0.10.0", promptId: "ab12", auth: "bearer", ...over },
});

describe("the empty conversation's capability line", () => {
  it("states only what the capability document carries", () => {
    expect(capabilityLine(known({ manifestRuns: true }))).toBe("This agent can run manifests and their tests.");
    expect(capabilityLine(known({ manifestRuns: false, auth: "none" }))).toBe(
      "This agent cannot run manifests or their tests, and accepts requests without a token.",
    );
    expect(capabilityLine(known({}))).toBeNull();
  });

  it("claims nothing for an agent whose capabilities are unknown", () => {
    expect(capabilityLine(null)).toBeNull();
    expect(capabilityLine({ state: "unavailable" })).toBeNull();
    expect(capabilityLine({ state: "failed", message: "offline" })).toBeNull();
  });
});
