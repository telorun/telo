import type { ResourceInstance } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { readingOf } from "../src/mount-access.js";

describe("readingOf", () => {
  it("does not cache a rejected snapshot, so the next read retries", async () => {
    let calls = 0;
    const instance = {
      snapshot: async () => {
        if (++calls === 1) throw new Error("not ready");
        return { schemes: ["Bearer"] };
      },
    } as unknown as ResourceInstance;
    await expect(readingOf(instance)).rejects.toThrow("not ready");
    expect(await readingOf(instance)).toEqual({ schemes: ["Bearer"] });
    await readingOf(instance);
    expect(calls).toBe(2);
  });
});
