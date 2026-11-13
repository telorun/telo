import { describe, expect, it } from "vitest";
import { SHIPPED_ADAPTERS, type EcosystemAdapter } from "../src/index.js";
import { readReleaseMarker, requireReleaseSettings } from "../src/release-settings.js";

/** An ecosystem this package does not ship, reading settings of its own — one
 *  named like a shipped ecosystem's. */
const fixtureAdapter: EcosystemAdapter = {
  ecosystem: "fixture",
  anchorDescription: "a directory holding fixture.txt",
  keys: {
    channel: { type: "string", description: "Where a fixture publishes." },
    registry: { type: "string", description: "The fixture's own registry." },
  },
  versionFile: { file: "fixture.txt" },
  recognize: (probe) =>
    probe.readFile("fixture.txt") === undefined ? undefined : { contributesLayer: true },
};

const adapters = [...SHIPPED_ADAPTERS, fixtureAdapter];
const read = (text: string) => readReleaseMarker(text, "telo-workspace.yaml", adapters);
const findings = (text: string) => read(text).diagnostics.map((d) => [d.code, d.path.join(".")]);

describe("release.units entries", () => {
  it("reads the three ecosystem forms, a name and a set anchoring at the unit", () => {
    const { release, diagnostics } = read(
      [
        "release:",
        "  units:",
        "    - { path: packages/*, ecosystem: npm }",
        "    - { path: apps/api, ecosystem: [npm, docker] }",
        "    - path: engine",
        "      ecosystem: { npm: nodejs, cargo: [rust, ./rust/core/] }",
        "      version: nodejs/package.json",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    expect(release!.units.map((u) => [u.path, Object.fromEntries(u.ecosystem!)])).toEqual([
      ["packages/*", { npm: ["."] }],
      ["apps/api", { npm: ["."], docker: ["."] }],
      ["engine", { npm: ["nodejs"], cargo: ["rust", "rust/core"] }],
    ]);
  });

  it("reads a version location as a file or { file, pointer }, and a payload as patterns or a command", () => {
    const { release, diagnostics } = read(
      [
        "release:",
        "  units:",
        "    - { path: ext, version: package.json, payload: { command: vsce ls } }",
        "    - path: lib",
        "      version: { file: pyproject.toml, pointer: /project/version }",
        "      payload: [src/**]",
        "      versionFiles: ['**/VERSION', { path: chart/values.yaml, pointer: /image/tag }]",
        "      maxBump: minor",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    expect(release!.units[0]).toMatchObject({ version: { file: "package.json" }, payload: { command: "vsce ls" } });
    expect(release!.units[1]).toMatchObject({
      version: { file: "pyproject.toml", pointer: "/project/version" },
      payload: { patterns: ["src/**"] },
      versionFiles: [{ pattern: "**/VERSION" }, { path: "chart/values.yaml", pointer: "/image/tag" }],
      maxBump: "minor",
    });
  });
});

describe("version resolution from the text", () => {
  it("resolves the one anchor whose ecosystem keeps a version, in any set order", () => {
    expect(findings("release:\n  units:\n    - { path: a, ecosystem: [npm, docker] }\n")).toEqual([]);
    expect(findings("release:\n  units:\n    - { path: a, ecosystem: [docker, npm] }\n")).toEqual([]);
  });

  it("refuses several defaulting anchors, whatever their order", () => {
    for (const set of ["[npm, cargo]", "[cargo, npm]"]) {
      const { diagnostics } = read(`release:\n  units:\n    - { path: napi, ecosystem: ${set} }\n`);
      expect(diagnostics.map((d) => d.code)).toEqual(["WORKSPACE_UNIT_VERSION_UNRESOLVED"]);
      expect(diagnostics[0]!.message).toContain("2 anchors keep one");
    }
  });

  it("refuses an entry where no anchor keeps a version", () => {
    expect(findings("release:\n  units:\n    - { path: img, ecosystem: docker }\n")).toEqual([
      ["WORKSPACE_UNIT_VERSION_UNRESOLVED", "release.units.0"],
    ]);
  });

  it("accepts a declared version over several defaulting anchors", () => {
    expect(
      findings("release:\n  units:\n    - { path: napi, ecosystem: [npm, cargo], version: package.json }\n"),
    ).toEqual([]);
  });

  it("asks an entry with no ecosystem for its own version and payload", () => {
    expect(findings("release:\n  units:\n    - tools\n")).toEqual([
      ["WORKSPACE_UNIT_PAYLOAD_EMPTY", "release.units.0"],
      ["WORKSPACE_UNIT_VERSION_UNRESOLVED", "release.units.0"],
    ]);
  });
});

describe("anchors", () => {
  it("refuses a pattern, a path leaving the unit and an absolute path", () => {
    expect(
      findings(
        "release:\n  units:\n    - path: e\n      version: v\n      ecosystem: { npm: '*', cargo: [../x, /abs] }\n",
      ),
    ).toEqual([
      ["WORKSPACE_ANCHOR_INVALID", "release.units.0.ecosystem.npm"],
      ["WORKSPACE_ANCHOR_INVALID", "release.units.0.ecosystem.cargo.0"],
      ["WORKSPACE_ANCHOR_INVALID", "release.units.0.ecosystem.cargo.1"],
    ]);
  });
});

describe("keys and ecosystems", () => {
  it("reads an anchor's settings over the block's, per ecosystem", () => {
    const { release, diagnostics } = read(
      [
        "release:",
        "  ecosystems: { fixture: { channel: stable, registry: fx://base }, docker: { registry: ghcr.io/acme } }",
        "  units:",
        "    - path: f",
        "      ecosystem: { fixture: { '.': { channel: beta } }, docker: { '.': { context: ., name: web } } }",
        "      version: fixture.txt",
        "    - path: c",
        "      ecosystem: { cargo: { rust: {}, rust/core: {} } }",
        "      version: rust/Cargo.toml",
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    expect(Object.fromEntries(release!.ecosystems)).toEqual({
      fixture: { channel: "stable", registry: "fx://base" },
      docker: { registry: "ghcr.io/acme" },
    });
    const f = release!.units[0]!;
    expect(Object.fromEntries(f.ecosystem!)).toEqual({ fixture: ["."], docker: ["."] });
    expect(f.anchorSettings.get("fixture")?.get(".")).toEqual({ channel: "beta" });
    expect(f.anchorSettings.get("docker")?.get(".")).toEqual({ context: ".", name: "web" });
    expect(Object.fromEntries(release!.units[1]!.ecosystem!)).toEqual({ cargo: ["rust", "rust/core"] });
  });

  it("refuses an ecosystem's setting written flat on an entry, naming where it goes", () => {
    const { diagnostics } = read("release:\n  units:\n    - { path: f, ecosystem: fixture, channel: beta }\n");
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["WORKSPACE_UNKNOWN_KEY", "release.units.0.channel"],
    ]);
    expect(diagnostics[0]!.message).toContain("release.ecosystems.fixture");
  });

  it("refuses a key the anchor's ecosystem does not read, at an anchor and in the block", () => {
    const { diagnostics } = read(
      "release:\n  ecosystems: { npm: { registry: x } }\n  units:\n    - { path: p, ecosystem: { npm: { '.': { registry: y } } } }\n",
    );
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["WORKSPACE_UNKNOWN_KEY", "release.ecosystems.npm.registry"],
      ["WORKSPACE_UNKNOWN_KEY", "release.units.0.ecosystem.npm...registry"],
    ]);
    expect(diagnostics.every((d) => d.message.includes("not read by the npm ecosystem"))).toBe(true);
  });

  it("refuses a docker context that is a pattern or leaves the workspace", () => {
    expect(
      findings(
        "release:\n  units:\n    - path: a\n      version: v\n      ecosystem: { docker: { '.': { context: ../outside } }, helm: chart }\n" +
          "    - path: b\n      version: v\n      ecosystem: { docker: { '.': { context: 'apps/*' } } }\n",
      ),
    ).toEqual([
      ["WORKSPACE_ANCHOR_INVALID", "release.units.0.ecosystem.docker...context"],
      ["WORKSPACE_ANCHOR_INVALID", "release.units.1.ecosystem.docker...context"],
    ]);
  });

  it("refuses a release.ecosystems key naming an unregistered ecosystem", () => {
    expect(findings("release:\n  ecosystems: { pypi: { index: x } }\n  units: [{ path: a, ecosystem: npm }]\n")).toEqual([
      ["WORKSPACE_ECOSYSTEM_UNAVAILABLE", "release.ecosystems.pypi"],
    ]);
  });

  it("suggests the near miss of a core key", () => {
    const { diagnostics } = read("release:\n  units:\n    - { path: p, ecosystem: npm, verion: x }\n");
    expect(diagnostics[0]!.message).toContain("Did you mean 'version'?");
  });

  it("refuses an ecosystem no adapter serves, naming the host that does", () => {
    const { diagnostics } = readReleaseMarker(
      "release:\n  units:\n    - { path: m, ecosystem: telo }\n",
      "telo-workspace.yaml",
      SHIPPED_ADAPTERS,
      { ecosystemHosts: { telo: "the `telo` CLI" } },
    );
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["WORKSPACE_ECOSYSTEM_UNAVAILABLE", "release.units.0.ecosystem"],
    ]);
    expect(diagnostics[0]!.message).toContain("the `telo` CLI");
  });

  it("refuses the module list and the block-wide registry, naming where each went", () => {
    const { diagnostics } = read("release:\n  registry: oci://x\n  modules: [modules/*]\n");
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["WORKSPACE_MODULES_MOVED", "release.registry"],
      ["WORKSPACE_MODULES_MOVED", "release.modules"],
    ]);
    expect(diagnostics[0]!.message).toContain("release.ecosystems");
    expect(diagnostics[1]!.message).toContain("release.units");
  });

  it("reports a null path in an entry", () => {
    expect(findings("release:\n  units:\n    - { path: }\n")).toEqual([
      ["WORKSPACE_INVALID_VALUE", "release.units.0.path"],
    ]);
  });
});

describe("the block's own keys", () => {
  it("reads groups and maxBump, refusing a unit in two groups", () => {
    const { release, diagnostics } = read(
      "release:\n  maxBump: minor\n  units: [{ path: a, ecosystem: npm }]\n  groups:\n    line: [a, b]\n    other: [b]\n",
    );
    expect(release!.maxBump).toBe("minor");
    expect(Object.fromEntries(release!.groups)).toEqual({ line: ["a", "b"], other: [] });
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["WORKSPACE_INVALID_VALUE", "release.groups.other.0"],
    ]);
  });

  it("throws for a release command when no unit is declared", () => {
    expect(() => requireReleaseSettings(read("# anchor\n"), "telo-workspace.yaml")).toThrow(
      /declares no 'release\.units'/,
    );
  });
});
