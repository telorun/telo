import { describe, expect, it } from "vitest";
import type { AvailableKind } from "../model";
import { categoryLabels, filterByCategory, groupKinds } from "./kind-picker-groups";

function kind(
  fullKind: string,
  options: { contract?: string; categories?: string[] } = {},
): AvailableKind {
  const [alias, kindName] = fullKind.split(".");
  return {
    fullKind,
    alias,
    kindName,
    capability: "Telo.Provider",
    schema: {},
    categories: options.categories ?? [],
    contract: options.contract,
  };
}

describe("groupKinds", () => {
  it("groups backends of one contract together across their modules", () => {
    const groups = groupKinds([
      kind("CacheRedis.Store", { contract: "cache.Store" }),
      kind("Run.Sequence"),
      kind("CacheMemory.Store", { contract: "cache.Store" }),
    ]);

    // Case-insensitive alphabetical, so a lowercase contract name and a
    // PascalCase alias interleave by word rather than by ASCII code.
    expect(groups.map((g) => g.label)).toEqual(["cache.Store", "Run"]);
    expect(groups.find((g) => g.label === "cache.Store")?.kinds.map((k) => k.fullKind)).toEqual([
      "CacheMemory.Store",
      "CacheRedis.Store",
    ]);
    expect(groups.find((g) => g.label === "Run")?.contract).toBe(false);
  });
});

describe("categoryLabels", () => {
  it("offers each declared label once, case-insensitively, first spelling winning", () => {
    const labels = categoryLabels([
      kind("Ai.Model", { categories: ["AI"] }),
      kind("Embedding.Model", { categories: ["ai", "Storage"] }),
    ]);

    expect(labels).toEqual(["AI", "Storage"]);
  });
});

describe("filterByCategory", () => {
  it("matches a chip against differently-cased labels, and passes everything through when unset", () => {
    const kinds = [
      kind("Ai.Model", { categories: ["AI"] }),
      kind("Embedding.Model", { categories: ["ai"] }),
      kind("Run.Sequence", { categories: ["Compute"] }),
    ];

    expect(filterByCategory(kinds, "AI").map((k) => k.fullKind)).toEqual([
      "Ai.Model",
      "Embedding.Model",
    ]);
    expect(filterByCategory(kinds, null)).toHaveLength(3);
  });
});
