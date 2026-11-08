import { describe, expect, it } from "vitest";

import {
  manifestCompatibility,
  readModuleVersion,
  selectionCompatibility,
  type ModuleVersionRequirements,
} from "../src/module-compatibility.js";

const TELO_CEILING = "Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.";
const NODE_CEILING = "Lookup's HTTP client crashes on Node 24; a fix ships in 1.3.0.";
const LIFT = "Lookup works on every telo again since telo 0.122.1 fixed the regression.";

function geocode(version: string, head: string): ModuleVersionRequirements {
  return readModuleVersion({
    version,
    text: `kind: Telo.Library\nmetadata: { name: Geocode, version: ${version} }\n${head}`,
  });
}

// The plan's Geocode history, oldest first.
const v110 = geocode("1.1.0", `requires: { telo: ">=0.110.0" }\n`);
const v120 = geocode("1.2.0", `requires: { telo: ">=0.121.0" }\n`);
const v121 = geocode(
  "1.2.1",
  `requires: { telo: ">=0.121.0" }
restrictions:
  - { versions: ">=1.2.0", requires: { telo: "<0.122.0" }, reason: "${TELO_CEILING}" }
  - { versions: ">=1.2.0", requires: { host: { node: "<24.0.0" } }, reason: "${NODE_CEILING}" }
`,
);
const v130 = geocode("1.3.0", `requires: { telo: ">=0.123.0" }\n`);
const v131 = geocode(
  "1.3.1",
  `requires: { telo: ">=0.123.0" }
restrictions:
  - { versions: ">=1.2.0 <=1.2.1", requires: { telo: ">=0.121.0" }, reason: "${LIFT}" }
`,
);

/** Each candidate's verdict against every version published so far. */
function select(published: ModuleVersionRequirements[], telo: string, node = "22.0.0") {
  return Object.fromEntries(
    published.map((candidate) => {
      const verdict = selectionCompatibility(candidate, published, telo, { node });
      const by = "source" in verdict && verdict.source.from === "restriction" ? verdict.source.version : undefined;
      return [candidate.version, by ? `${verdict.compatibility} by ${by}` : verdict.compatibility];
    }),
  );
}

describe("selectionCompatibility", () => {
  it("holds back the versions a later release restricts, by that release's reason", () => {
    const published = [v110, v120, v121];
    expect(select(published, "0.122.0")).toEqual({
      "1.1.0": "yes",
      "1.2.0": "too-old by 1.2.1",
      "1.2.1": "too-old by 1.2.1",
    });
    const verdict = selectionCompatibility(v120, published, "0.122.0", { node: "22.0.0" });
    expect(verdict).toMatchObject({ key: "telo", bound: "<0.122.0", source: { reason: TELO_CEILING } });
  });

  it("selects the restricted line where its runtimes are met, on each key", () => {
    const published = [v110, v120, v121];
    expect(select(published, "0.121.0", "22.0.0")["1.2.1"]).toBe("yes");
    expect(select(published, "0.121.0", "24.0.0")).toEqual({
      "1.1.0": "yes",
      "1.2.0": "too-old by 1.2.1",
      "1.2.1": "too-old by 1.2.1",
    });
  });

  // Omitting an entry lifts nothing: 1.3.0 states no telo key for 1.2.x.
  it("keeps an older statement when a later release omits it", () => {
    expect(select([v110, v120, v121, v130], "0.122.0")).toEqual({
      "1.1.0": "yes",
      "1.2.0": "too-old by 1.2.1",
      "1.2.1": "too-old by 1.2.1",
      "1.3.0": "too-new",
    });
  });

  // Lifting restates the key from a newer version; the unrestated host key
  // still holds, and a version's own entries always apply to it.
  it("lifts a key restated by a newer release, and only that key", () => {
    const published = [v110, v120, v121, v130, v131];
    expect(select(published, "0.122.1", "22.0.0")).toEqual({
      "1.1.0": "yes",
      "1.2.0": "yes",
      "1.2.1": "too-old by 1.2.1",
      "1.3.0": "too-new",
      "1.3.1": "too-new",
    });
    expect(select(published, "0.122.1", "24.0.0")["1.2.0"]).toBe("too-old by 1.2.1");
  });

  // Prereleases speak only when no release does.
  it("reads a newer prerelease's entries only when no release speaks on the key", () => {
    const rc = geocode(
      "1.3.0-rc.1",
      `restrictions:\n  - { versions: ">=1.2.0", requires: { telo: "<0.110.0" }, reason: "rc" }\n`,
    );
    expect(select([v120, rc], "0.121.0")["1.2.0"]).toBe("too-old by 1.3.0-rc.1");
    expect(select([v120, v121, rc], "0.121.5")["1.2.0"]).toBe("yes");
  });

  it("answers unreadable for a candidate whose own entry is malformed, and unknown for no module", () => {
    const malformed = geocode("1.0.0", `restrictions: [{ requires: { telo: "<0.1.0" } }]\n`);
    expect(selectionCompatibility(malformed, [], "0.122.0").compatibility).toBe("unreadable");
    expect(selectionCompatibility({ version: "1.0.0", text: "kind: Http.Api\n" }, [], "0.122.0").compatibility).toBe(
      "unknown",
    );
  });
});

describe("manifestCompatibility", () => {
  // A published ceiling is honoured, not unreadable; the four-valued verdict
  // holds it back as too-new, as before.
  it("holds back a published ceiling and an own covering entry", () => {
    const ceiling = `kind: Telo.Library\nmetadata: { name: G, version: 1.0.0 }\nrequires: { telo: ">=0.1.0 <0.2.0" }\n`;
    expect(manifestCompatibility(ceiling, "0.1.5")).toBe("yes");
    expect(manifestCompatibility(ceiling, "0.2.0")).toBe("too-new");
    const entry =
      `kind: Telo.Library\nmetadata: { name: G, version: 1.0.0 }\n` +
      `restrictions: [{ requires: { telo: "<0.2.0" }, reason: "Broken." }]\n`;
    expect(manifestCompatibility(entry, "0.2.0")).toBe("too-new");
  });
});
