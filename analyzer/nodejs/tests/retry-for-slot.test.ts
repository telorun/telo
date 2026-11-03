import { describe, expect, it } from "vitest";
import { retryForProblems } from "../src/retry-for-slot.js";

describe("x-telo-retry-for placement", () => {
  it("refuses the annotation anywhere but a top-level property", () => {
    const problems = retryForProblems({
      metadata: { name: "Worker" },
      schema: {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: { retry: { "x-telo-retry-for": { slot: "/invoke" } } },
          },
        },
      },
    });
    expect(problems).toEqual([
      expect.objectContaining({
        path: "schema.properties.nested.properties.retry.x-telo-retry-for",
        message: expect.stringContaining("where nothing reads it"),
      }),
    ]);
  });
});
