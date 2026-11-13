import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  SHIPPED_ADAPTERS,
  readReleaseMarker,
  readUnitVersions,
  resolveUnits,
  stampUnitVersion,
  type WorkspaceTree,
} from "../src/index.js";

const registry = new AdapterRegistry(SHIPPED_ADAPTERS);

/** A tree from a file map; directories are every parent of a file. */
function tree(files: Record<string, string>): WorkspaceTree {
  const dirs = new Set<string>();
  for (const file of Object.keys(files)) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return {
    directories: () => [...dirs].sort(),
    filesUnder: (dir) =>
      Object.keys(files)
        .filter((file) => dir === "" || file.startsWith(`${dir}/`))
        .map((file) => (dir === "" ? file : file.slice(dir.length + 1))),
    readFile: (path) => files[path],
  };
}

function resolve(marker: string, files: Record<string, string>) {
  const read = readReleaseMarker(marker, "telo-workspace.yaml", SHIPPED_ADAPTERS);
  expect(read.diagnostics).toEqual([]);
  return resolveUnits(read.release!, tree(files), registry);
}

const pkg = (version: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "p", version, ...extra }, null, 2) + "\n";
const crate = (version: string) => `[package]\nname = "c"\nversion = "${version}"\n`;

describe("resolving units", () => {
  it("reads the version from the one anchor that keeps one, in any set order", () => {
    for (const set of ["[npm, docker]", "[docker, npm]"]) {
      const { units } = resolve(`release:\n  units:\n    - { path: apps/api, ecosystem: ${set} }\n`, {
        "apps/api/package.json": pkg("1.0.0"),
        "apps/api/Dockerfile": "FROM x\n",
      });
      expect(units.map((u) => [u.key, u.version, u.anchors.map((a) => a.ecosystem)])).toEqual([
        ["apps/api", { file: "apps/api/package.json" }, ["docker", "npm"]],
      ]);
    }
  });

  it("writes every anchor's location, versionFiles included, reading the declared one", () => {
    const files = {
      "engine/nodejs/package.json": pkg("0.3.0"),
      "engine/rust/Cargo.toml": crate("0.3.0"),
      "engine/rust/core/Cargo.toml": crate("0.3.0"),
      "engine/VERSION": "0.3.0\n",
    };
    const { units } = resolve(
      [
        "release:",
        "  units:",
        "    - path: engine",
        "      ecosystem: { npm: nodejs, cargo: [rust, rust/core] }",
        "      version: nodejs/package.json",
        "      versionFiles: [VERSION]",
      ].join("\n"),
      files,
    );
    const unit = units[0]!;
    expect(unit.versionLocations.map((l) => l.file)).toEqual([
      "engine/nodejs/package.json",
      "engine/rust/Cargo.toml",
      "engine/rust/core/Cargo.toml",
      "engine/VERSION",
    ]);
    const written = Object.fromEntries(
      stampUnitVersion(unit, "0.4.0", (p) => files[p as keyof typeof files], registry).map((w) => [w.file, w.text]),
    );
    expect(written["engine/rust/core/Cargo.toml"]).toBe(crate("0.4.0"));
    expect(written["engine/VERSION"]).toBe("0.4.0\n");
    expect(JSON.parse(written["engine/nodejs/package.json"]!).version).toBe("0.4.0");
  });

  it("skips a directory a pattern entry matches but no adapter recognises", () => {
    const { units, diagnostics } = resolve("release:\n  units:\n    - { path: packages/*, ecosystem: npm }\n", {
      "packages/a/package.json": pkg("1.0.0"),
      "packages/docs/README.md": "x",
    });
    expect(units.map((u) => u.key)).toEqual(["packages/a"]);
    expect(diagnostics).toEqual([]);
  });

  it("refuses a literal unit whose anchor holds no package", () => {
    const { units, diagnostics } = resolve("release:\n  units:\n    - { path: tool, ecosystem: cargo }\n", {
      "tool/README.md": "x",
    });
    expect(units).toEqual([]);
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["WORKSPACE_ANCHOR_INVALID", "release.units.0.ecosystem"],
    ]);
  });

  it("refuses one package claimed by two units, naming both", () => {
    const { diagnostics } = resolve(
      "release:\n  units:\n    - { path: kernel, ecosystem: { npm: nodejs } }\n    - { path: kernel/nodejs, ecosystem: npm }\n",
      { "kernel/nodejs/package.json": pkg("1.0.0") },
    );
    expect(diagnostics.map((d) => d.code)).toEqual(["WORKSPACE_ANCHOR_CLAIMED"]);
    expect(diagnostics[0]!.message).toContain("'kernel' and 'kernel/nodejs'");
  });

  it("refuses a unit left with no layer — a private npm package publishes nothing", () => {
    const { units, diagnostics } = resolve("release:\n  units:\n    - { path: tools, ecosystem: npm }\n", {
      "tools/package.json": pkg("1.0.0", { private: true }),
    });
    expect(units).toEqual([]);
    expect(diagnostics.map((d) => d.code)).toEqual(["WORKSPACE_UNIT_PAYLOAD_EMPTY"]);
    expect(diagnostics[0]!.message).toContain("declare 'payload:', or exclude it with '!tools'");
  });

  it("keeps a private package's version location when a declared payload gives the unit a layer", () => {
    const { units } = resolve("release:\n  units:\n    - { path: tools, ecosystem: npm, payload: [src/**] }\n", {
      "tools/package.json": pkg("1.0.0", { private: true }),
    });
    expect(units.map((u) => u.version.file)).toEqual(["tools/package.json"]);
  });

  it("lets the last matching entry decide, and an exclusion remove a unit", () => {
    const { units } = resolve(
      [
        "release:",
        "  units:",
        "    - { path: packages/*, ecosystem: npm }",
        "    - '!packages/scratch'",
        "    - { path: packages/core, ecosystem: npm, maxBump: patch }",
      ].join("\n"),
      {
        "packages/core/package.json": pkg("1.0.0"),
        "packages/scratch/package.json": pkg("1.0.0"),
        "packages/ui/package.json": pkg("1.0.0"),
      },
    );
    expect(units.map((u) => [u.key, u.maxBump])).toEqual([
      ["packages/core", "patch"],
      ["packages/ui", "major"],
    ]);
  });

  it("reads every location, so a disagreement can be judged", () => {
    const files = {
      "engine/nodejs/package.json": pkg("0.3.0"),
      "engine/rust/Cargo.toml": crate("0.2.9"),
    };
    const { units } = resolve(
      "release:\n  units:\n    - { path: engine, ecosystem: { npm: nodejs, cargo: rust }, version: nodejs/package.json }\n",
      files,
    );
    expect(readUnitVersions(units[0]!, (p) => files[p as keyof typeof files], registry).map((r) => r.value)).toEqual([
      "0.3.0",
      "0.2.9",
    ]);
  });

  it("refuses a group member that is no unit", () => {
    const { diagnostics } = resolve(
      "release:\n  units: [{ path: a, ecosystem: npm }]\n  groups:\n    line: [a, missing]\n",
      { "a/package.json": pkg("1.0.0") },
    );
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["WORKSPACE_INVALID_VALUE", "release.groups.line.1"],
    ]);
  });
});
