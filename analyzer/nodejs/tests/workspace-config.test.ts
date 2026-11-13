import { describe, expect, it } from "vitest";
import { lastMatchIndex } from "@telorun/glob";
import {
  AdapterRegistry,
  DEFAULT_RELEASE_IGNORE,
  diagnosticsFor,
  resolveUnits,
  type WorkspaceTree,
} from "@telorun/release";
import { checkDestinationCollisions } from "../src/release/destinations.js";
import {
  TELO_RELEASE_ADAPTERS,
  modulePackageFiles,
  teloLegacyLedgerLayers,
} from "../src/release/telo-adapter.js";
import {
  DEFAULT_ENV_FILES,
  matchesPatterns,
  readWorkspaceConfig,
} from "../src/release/workspace-config.js";

const read = (text: string) => readWorkspaceConfig(text, "telo-workspace.yaml");
const codes = (text: string) => read(text).diagnostics.map((d) => d.code);

describe("the marker's shape", () => {
  it("accepts a file whose whole content is comments — what a runner seeds", () => {
    const { config, diagnostics } = read("# just an anchor\n");
    expect(diagnostics).toEqual([]);
    expect(config).toEqual({});
  });

  it("names release.units when 'modules:' sits at the top level", () => {
    const { diagnostics } = read("modules:\n  - modules/*\n");
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([["WORKSPACE_MODULES_MOVED", "modules"]]);
    expect(diagnostics[0]!.message).toContain("release.units");
  });

  it("reports every problem, not just the first — an editor wants all of them", () => {
    const { diagnostics } = read("release:\n  units: [{ path: m, ecosystem: telo, registry: 7 }]\n  nope: 1\nenv:\n  filez: []\n");
    expect(diagnostics.map((d) => d.path.join("."))).toEqual([
      "release.nope",
      "release.units.0.registry",
      "env.filez",
    ]);
  });

  it("reads a telo anchor's registry, and refuses it flat on an entry or on another ecosystem", () => {
    const release = read(
      "release:\n  ecosystems: { telo: { registry: oci://x/base } }\n  units:\n    - { path: modules/*, ecosystem: { telo: { '.': { registry: oci://x/y } } } }\n",
    ).config.release!;
    expect(release.units[0]!.anchorSettings.get("telo")?.get(".")).toEqual({ registry: "oci://x/y" });
    expect(release.ecosystems.get("telo")).toEqual({ registry: "oci://x/base" });
    expect(codes("release:\n  units:\n    - { path: modules/*, ecosystem: telo, registry: oci://x/y }\n")).toEqual([
      "WORKSPACE_UNKNOWN_KEY",
    ]);
    expect(codes("release:\n  units:\n    - { path: p, ecosystem: { npm: { '.': { registry: oci://x/y } } } }\n")).toEqual([
      "WORKSPACE_UNKNOWN_KEY",
    ]);
  });

  it("errors on a near-miss block and warns on one it is merely too old to know", () => {
    expect(read("relase:\n  units: [x]\n").diagnostics[0]!.severity).toBe("error");
    expect(read("telemetry:\n  sink: x\n").diagnostics[0]!.severity).toBe("warning");
  });

  it("refuses a path or a glob in env.files, since the walk's reach is env.roots", () => {
    const { diagnostics } = read("env:\n  files: ['.env', 'cfg/.env']\n");
    expect(diagnostics.map((d) => d.path)).toEqual([["env", "files", 1]]);
  });

  it("reads an env.files entry as a filename or { name, sensitive }", () => {
    const { config, diagnostics } = read("env:\n  files: [.env, { name: .secrets, sensitive: true }]\n");
    expect(diagnostics).toEqual([]);
    expect(config.env?.files).toEqual([
      { name: ".env", sensitive: false },
      { name: ".secrets", sensitive: true },
    ]);
  });

  it("reports an env.files entry's unknown key and wrong-typed mark inside env:", () => {
    const { diagnostics } = read(
      "env:\n  files:\n    - { name: .env.local, sensitve: true }\n    - { name: .secrets, sensitive: yes please }\n",
    );
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([
      ["WORKSPACE_UNKNOWN_KEY", "env.files.0.sensitve"],
      ["WORKSPACE_INVALID_VALUE", "env.files.1.sensitive"],
    ]);
    expect(diagnostics[0]!.message).toContain("Did you mean 'sensitive'?");
  });

  it("reports a null sensitive: inside env.files, anchored at the key", () => {
    const { diagnostics } = read("env:\n  files:\n    - { name: secrets.txt, sensitive: }\n");
    expect(diagnostics.map((d) => [d.code, d.severity, d.path.join(".")])).toEqual([
      ["WORKSPACE_INVALID_VALUE", "error", "env.files.0.sensitive"],
    ]);
    expect(diagnostics[0]!.message).toContain("must be true or false");
  });

  it("reports a null name: in an env.files entry", () => {
    const { diagnostics } = read("env:\n  files:\n    - name:\n");
    expect(diagnostics.map((d) => [d.code, d.path.join(".")])).toEqual([["WORKSPACE_INVALID_VALUE", "env.files.0.name"]]);
    expect(diagnostics[0]!.message).toContain("names nothing");
  });
});

describe("what a caller does with the diagnostics", () => {
  it("scopes them per block, so a release typo does not reach the run path", () => {
    const { diagnostics } = read("release:\n  nope: 1\nenv:\n  files: ['a/b']\n");
    expect(diagnosticsFor(diagnostics, "env").map((d) => d.path.join("."))).toEqual(["env.files.0"]);
  });

  it("ignores a nested test suite at any depth beneath a unit", () => {
    expect(matchesPatterns("nodejs/tests/sql.test.ts", DEFAULT_RELEASE_IGNORE, lastMatchIndex)).toBe(true);
    expect(matchesPatterns("chat/tests/authors.yaml", DEFAULT_RELEASE_IGNORE, lastMatchIndex)).toBe(true);
    expect(matchesPatterns("nodejs/src/index.ts", DEFAULT_RELEASE_IGNORE, lastMatchIndex)).toBe(false);
  });
});

describe("the telo ecosystem", () => {
  const manifest = [
    "kind: Telo.Library",
    "metadata: { name: Console, version: 0.18.0 }",
    "sources:",
    "  napi:",
    "    version: 1.0.0",
    "    url: https://example.com/x.tar.gz",
    "    archive: tar.gz",
    "    notices: [LICENSE]",
    "    entries:",
    "      ./native/out.node: { upstream: x, member: out.node }",
    "    build: { cargo: native }",
    "---",
    "kind: Telo.Definition",
    "metadata: { name: WriteLine }",
    "capability: Telo.Invocable",
    "controllers:",
    "  - pkg:telo/local/js?path=./node/console.mjs&local_path=./node/src/index.ts#WriteLine",
    "  - pkg:cargo/telorun-console?local_path=./rust#write_line",
    "",
  ].join("\n");

  it("finds a module's packages from its controller locators and sources, not fixed subpaths", () => {
    const files = new Set(["node/package.json", "rust/Cargo.toml", "native/Cargo.toml", "package.json"]);
    expect(modulePackageFiles(manifest, (relative) => files.has(relative))).toEqual([
      "native/Cargo.toml",
      "node/package.json",
      "rust/Cargo.toml",
    ]);
  });

  it("resolves a module unit whose version is its telo.yaml and whose packages carry it too", () => {
    const files: Record<string, string> = {
      "modules/console/telo.yaml": manifest,
      "modules/console/node/package.json": '{ "name": "@telorun/console-build", "version": "0.18.0", "private": true }',
      "modules/console/rust/Cargo.toml": '[package]\nname = "telorun-console"\nversion = "0.18.0"\n',
      "modules/notes/README.md": "not a module",
    };
    const tree: WorkspaceTree = {
      directories: () => ["modules", "modules/console", "modules/console/node", "modules/console/rust", "modules/notes"],
      filesUnder: () => [],
      readFile: (path) => files[path],
    };
    const { config, diagnostics } = read("release:\n  units:\n    - { path: modules/*, ecosystem: telo }\n");
    expect(diagnostics).toEqual([]);
    const resolved = resolveUnits(config.release!, tree, new AdapterRegistry(TELO_RELEASE_ADAPTERS));
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.units.map((u) => [u.key, u.versionLocations.map((l) => l.file)])).toEqual([
      [
        "modules/console",
        ["modules/console/telo.yaml", "modules/console/node/package.json", "modules/console/rust/Cargo.toml"],
      ],
    ]);
  });

  it("nests a module ledger's flat layers under the module's anchor, an image digest under docker", () => {
    expect(teloLegacyLedgerLayers("apps/hub", { image: "sha256-i" })).toEqual({ ecosystems: { docker: { ".": "sha256-i" } } });
    expect(teloLegacyLedgerLayers("modules/sql", { manifest: "sha256-m" })).toEqual({
      ecosystems: { telo: { ".": { manifest: "sha256-m" } } },
    });
  });
});

describe("destinations", () => {
  it("refuses two modules resolving to one ref", () => {
    const diagnostics = checkDestinationCollisions([
      { key: "vendor/aws/storage", destination: "oci://ghcr.io/acme/storage" },
      { key: "vendor/google/storage", destination: "oci://ghcr.io/acme/storage" },
      { key: "modules/sql", destination: "oci://ghcr.io/acme/sql" },
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["DESTINATION_COLLISION"]);
    expect(diagnostics[0]!.message).toContain("vendor/aws/storage and vendor/google/storage");
  });
});

describe("env defaults", () => {
  it("keeps .env then .env.local, the second sensitive", () => {
    expect(DEFAULT_ENV_FILES).toEqual([
      { name: ".env", sensitive: false },
      { name: ".env.local", sensitive: true },
    ]);
  });
});
