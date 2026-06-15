import { afterEach, describe, expect, it } from "vitest";
import { resolveUiBundle } from "../src/ui-fetch.js";

describe("resolveUiBundle", () => {
  afterEach(() => {
    delete process.env.TELO_DEBUG_UI_PATH;
  });

  it("returns the override path when TELO_DEBUG_UI_PATH points at a real file", async () => {
    // Any existing file proves the override branch; the resolver only checks existence.
    process.env.TELO_DEBUG_UI_PATH = new URL(import.meta.url).pathname;
    const result = await resolveUiBundle(null);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.path).toBe(process.env.TELO_DEBUG_UI_PATH);
  });

  it("reports an explicit reason naming the override when it points nowhere", async () => {
    process.env.TELO_DEBUG_UI_PATH = "/no/such/debug-ui.html";
    const result = await resolveUiBundle(null);
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.reason).toContain("/no/such/debug-ui.html");
    }
  });
});
