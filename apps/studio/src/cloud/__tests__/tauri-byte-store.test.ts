import { describe, expect, it } from "vitest";
import { repositoryName, storedName } from "../tauri-byte-store";

describe("stored names", () => {
  it("never start with a dot, and map back", () => {
    for (const name of [".gitignore", ".github", "..hidden", "plain.txt", "100%.md", "%2Eliteral", ".%25"]) {
      const stored = storedName(name);
      expect(stored.startsWith(".")).toBe(false);
      expect(repositoryName(stored)).toBe(name);
    }
  });
});
