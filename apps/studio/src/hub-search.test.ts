import { afterEach, describe, expect, it, vi } from "vitest";
import { hubHitTitle, matchChips, searchHubModules, type HubModuleHit } from "./hub-search";

const hit = (matchedKinds: HubModuleHit["matchedKinds"]): HubModuleHit =>
  ({ module: { ref: "oci://x/console" }, matchedKinds }) as HubModuleHit;

describe("matchChips", () => {
  it("lists each kind once and an instance by its own name", () => {
    const chips = matchChips(
      hit([
        { entry: "kind", name: "WriteLine", kind: "WriteLine", capability: "", description: "", score: 1 },
        { entry: "instance", name: "writeLine", kind: "WriteLine", capability: "", description: "", score: 1 },
        { entry: "kind", name: "WriteLine", kind: "WriteLine", capability: "", description: "", score: 1 },
        { kind: "Write", capability: "", description: "", score: 1 },
      ]),
    );
    expect(chips).toEqual([
      { name: "WriteLine", instance: false },
      { name: "writeLine", instance: true },
      { name: "Write", instance: false },
    ]);
  });
});

describe("searchHubModules", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not offer the built-in vocabulary", async () => {
    const hits = [
      { module: { ref: "oci://x/console" } },
      { module: { ref: "oci://x/telo", builtin: true } },
    ];
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => ({ query: "q", hits }) }));
    const found = await searchHubModules("https://hub.test", "q");
    expect(found.map((h) => h.module.ref)).toEqual(["oci://x/console"]);
  });
});

describe("hubHitTitle", () => {
  const titled = (module: Record<string, string>) => ({ module }) as unknown as HubModuleHit;

  it("titles a result by the module's name", () => {
    expect(hubHitTitle(titled({ ref: "oci://ghcr.io/telorun/console", name: "Console" }))).toBe(
      "Console",
    );
  });

  it("falls back to the ref's last segment when the hub sends no name", () => {
    expect(hubHitTitle(titled({ ref: "oci://ghcr.io/telorun/console@0.19.6", name: "" }))).toBe(
      "console",
    );
  });
});
