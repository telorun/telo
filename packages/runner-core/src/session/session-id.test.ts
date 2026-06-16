import { describe, expect, it } from "vitest";

import { generateSessionId } from "./session-id.js";

describe("generateSessionId", () => {
  it("is a 12-char lowercase base32 string, valid as a DNS label and k8s name", () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateSessionId()).toMatch(/^[a-z2-7]{12}$/);
    }
  });

  it("does not repeat across many draws", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10000; i++) ids.add(generateSessionId());
    expect(ids.size).toBe(10000);
  });
});
