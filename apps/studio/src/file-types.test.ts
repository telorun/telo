import { describe, expect, it } from "vitest";
import { languageForFile } from "./file-types";

describe("languageForFile", () => {
  it("highlights env files as ini", () => {
    expect(languageForFile("/ws/.env")).toBe("ini");
    expect(languageForFile("/ws/apps/shop/.env.local")).toBe("ini");
  });
});
