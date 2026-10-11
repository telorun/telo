import { describe, expect, it } from "vitest";

import { STARTER_PROMPTS } from "../starter-prompts";

describe("starter prompts", () => {
  it("are four distinct requests, each with a label shorter than what it asks for", () => {
    expect(STARTER_PROMPTS).toHaveLength(4);
    expect(new Set(STARTER_PROMPTS.map((p) => p.id)).size).toBe(4);
    for (const starter of STARTER_PROMPTS) {
      expect(starter.label.length).toBeGreaterThan(0);
      expect(starter.prompt.length).toBeGreaterThan(starter.label.length);
    }
  });
});
