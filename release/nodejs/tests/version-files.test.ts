import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  SHIPPED_ADAPTERS,
  VersionFileError,
  parseLedger,
  prependChangelogRelease,
  readVersionAt,
  renderChangelogRelease,
  serializeLedger,
  stampChartVersion,
  stampCrateVersion,
  stampLockedCrateVersion,
  stampPackageVersion,
  stampPathDependencyRequirements,
  writeVersionAt,
} from "../src/index.js";

const registry = new AdapterRegistry(SHIPPED_ADAPTERS);

describe("stampPackageVersion", () => {
  it("rewrites the top-level version and leaves formatting alone", () => {
    const json = '{\n  "name": "@telorun/sql",\n  "version": "0.12.1",\n  "private": false\n}\n';
    expect(stampPackageVersion(json, "0.14.0", "package.json")).toBe(
      '{\n  "name": "@telorun/sql",\n  "version": "0.14.0",\n  "private": false\n}\n',
    );
  });

  it("ignores a nested version, which belongs to a dependency", () => {
    const json = '{\n  "name": "x",\n  "dependencies": { "version": "9.9.9" }\n}\n';
    expect(stampPackageVersion(json, "1.0.0", "package.json")).toBeUndefined();
  });
});

describe("stampCrateVersion", () => {
  it("rewrites [package].version only", () => {
    const toml = ["[package]", 'name = "telorun-sql"', 'version = "0.0.0"', "", "[dependencies]", 'serde = { version = "1.0" }', ""].join("\n");
    const out = stampCrateVersion(toml, "0.14.0", "Cargo.toml")!;
    expect(out).toContain('version = "0.14.0"');
    expect(out).toContain('serde = { version = "1.0" }');
  });

  it("leaves a workspace-inherited version alone", () => {
    expect(stampCrateVersion('[package]\nname = "x"\nversion.workspace = true\n', "1.0.0", "Cargo.toml")).toBeUndefined();
  });

  it("returns undefined when there is no [package] table", () => {
    expect(stampCrateVersion("[workspace]\nmembers = []\n", "1.0.0", "Cargo.toml")).toBeUndefined();
  });
});

describe("stampLockedCrateVersion", () => {
  const lock = [
    "version = 4",
    "",
    "[[package]]",
    'name = "serde"',
    'version = "1.0.219"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    "",
    "[[package]]",
    'name = "telorun-console"',
    'version = "0.18.0"',
    "",
  ].join("\n");

  it("rewrites the workspace member's recorded version and nothing else", () => {
    expect(stampLockedCrateVersion(lock, "telorun-console", "0.18.1", "Cargo.lock")).toBe(
      lock.replace('version = "0.18.0"', 'version = "0.18.1"'),
    );
  });

  it("leaves a registry package of the same name alone", () => {
    expect(stampLockedCrateVersion(lock, "serde", "9.9.9", "Cargo.lock")).toBeUndefined();
  });

  it("refuses a name recorded twice as a path package", () => {
    const twice = `${lock}\n[[package]]\nname = "telorun-console"\nversion = "0.1.0"\n`;
    expect(() => stampLockedCrateVersion(twice, "telorun-console", "0.18.1", "Cargo.lock")).toThrow(VersionFileError);
  });

  it("refuses an entry with no version rather than leaving a stale one", () => {
    const broken = '[[package]]\nname = "telorun-console"\ndependencies = []\n';
    expect(() => stampLockedCrateVersion(broken, "telorun-console", "0.18.1", "Cargo.lock")).toThrow("records no version");
  });
});

describe("stampPathDependencyRequirements", () => {
  const manifest = [
    "[package]",
    'name = "app"',
    'version = "1.0.0"',
    "",
    "[dependencies]",
    'core = { path = "../core", version = "^1.0.0" }',
    'pinned = { path = "../core", version = ">=1, <2" }',
    'other = { path = "../other", version = "1.0.0" }',
    "",
    "[target.'cfg(unix)'.build-dependencies.core-build]",
    'package = "core"',
    'path = "../core"',
    'version = "1.0"',
    "",
  ].join("\n");

  it("moves each plain requirement on the crate at the path, keeping its operator", () => {
    expect(stampPathDependencyRequirements(manifest, "crates/app", "crates/core", "1.1.0-rc.1")).toBe(
      manifest
        .replace('version = "^1.0.0"', 'version = "^1.1.0-rc.1"')
        .replace('version = "1.0"\n', 'version = "1.1.0-rc.1"\n'),
    );
  });

  it("leaves a crate at another path and a manifest naming none unchanged", () => {
    expect(stampPathDependencyRequirements(manifest, "crates/app", "crates/elsewhere", "2.0.0")).toBe(manifest);
  });
});

describe("a chart", () => {
  it("writes version and appVersion together", () => {
    expect(stampChartVersion("name: api\nversion: 0.1.0\nappVersion: \"0.1.0\"\n", "0.2.0", "Chart.yaml")).toBe(
      "name: api\nversion: 0.2.0\nappVersion: \"0.2.0\"\n",
    );
  });

  it("adds appVersion after version when the chart has none", () => {
    expect(stampChartVersion("name: api\nversion: 0.1.0\ntype: application\n", "0.2.0", "Chart.yaml")).toBe(
      'name: api\nversion: 0.2.0\nappVersion: "0.2.0"\ntype: application\n',
    );
  });
});

describe("a version location", () => {
  it("reads and writes through a pointer into JSON, YAML and TOML", () => {
    const cases: [string, string, string, string][] = [
      ["a.json", "/meta/version", '{ "meta": { "version": "1.0.0" } }\n', '{ "meta": { "version": "2.0.0" } }\n'],
      ["values.yaml", "/image/tag", "image:\n  tag: '1.0.0' # pinned\n", "image:\n  tag: '2.0.0' # pinned\n"],
      [
        "pyproject.toml",
        "/project/version",
        '[project]\nname = "x"\nversion = "1.0.0"\n\n[tool.x]\nversion = "9"\n',
        '[project]\nname = "x"\nversion = "2.0.0"\n\n[tool.x]\nversion = "9"\n',
      ],
    ];
    for (const [file, pointer, before, after] of cases) {
      expect(readVersionAt({ file, pointer }, before, file, registry)).toBe("1.0.0");
      expect(writeVersionAt({ file, pointer }, before, "2.0.0", file, registry)).toBe(after);
    }
  });

  it("reads a file of no structured format as a plain version file", () => {
    expect(readVersionAt({ file: "VERSION" }, "1.2.3\n", "VERSION", registry)).toBe("1.2.3");
    expect(writeVersionAt({ file: "VERSION" }, "1.2.3\n", "1.3.0", "VERSION", registry)).toBe("1.3.0\n");
  });

  it("asks for a pointer into a structured file no handler reads", () => {
    expect(() => readVersionAt({ file: "meta.json" }, "{}", "meta.json", registry)).toThrow(/with \{ file, pointer \}/);
  });
});

describe("ledger", () => {
  it("round-trips nested layers, a declared payload and a candidate", () => {
    const text = serializeLedger({
      units: new Map([
        [
          "kernel",
          {
            version: "0.136.0",
            layers: {
              ecosystems: { npm: { nodejs: "sha256-n" }, cargo: { rust: "sha256-r", "rust/value": "sha256-v" } },
              payload: "sha256-p",
            },
            candidate: { version: "0.137.0-rc.1", layers: { ecosystems: { npm: { nodejs: "sha256-n2" } } } },
          },
        ],
        [
          "modules/sql",
          {
            version: "0.13.1",
            registry: "oci://example/org",
            layers: { ecosystems: { telo: { ".": { manifest: "sha256-m", "controller/js": "sha256-c" } } } },
          },
        ],
      ]),
    });
    expect(text).not.toMatch(/npm\/|cargo\/|telo\//);
    const parsed = parseLedger(text, "ledger.yaml");
    expect(parsed.units.get("kernel")!.layers.ecosystems.cargo).toEqual({ rust: "sha256-r", "rust/value": "sha256-v" });
    expect(parsed.units.get("kernel")!.layers.payload).toBe("sha256-p");
    expect(parsed.units.get("kernel")!.candidate!.version).toBe("0.137.0-rc.1");
    expect(parsed.units.get("modules/sql")).toEqual({
      version: "0.13.1",
      registry: "oci://example/org",
      layers: { ecosystems: { telo: { ".": { manifest: "sha256-m", "controller/js": "sha256-c" } } } },
    });
  });

  it("reads the flat module shape through the host's nesting, a top-level base given to every entry", () => {
    const parsed = parseLedger(
      "registry: oci://example/org\nmodules:\n  modules/sql:\n    version: 0.1.0\n    layers: { manifest: sha256-m }\n",
      "ledger.yaml",
      { legacyLayers: (unit, flat) => ({ ecosystems: { telo: { ".": flat } } }) },
    );
    expect(parsed.units.get("modules/sql")).toEqual({
      version: "0.1.0",
      registry: "oci://example/org",
      layers: { ecosystems: { telo: { ".": { manifest: "sha256-m" } } } },
    });
    expect(serializeLedger(parsed)).toContain("units:");
  });

  it("refuses the flat module shape when the host cannot nest it", () => {
    expect(() => parseLedger("modules: {}\n", "ledger.yaml")).toThrow(/module ledger shape/);
  });

  it("refuses an entry with no version, because a digest without one says nothing", () => {
    expect(() => parseLedger("units:\n  a:\n    layers: {}\n", "ledger.yaml")).toThrow(/no major\.minor\.patch 'version'/);
  });
});

describe("changelog", () => {
  it("groups entries by kind in the vocabulary's order", () => {
    const block = renderChangelogRelease({
      version: "0.14.0",
      date: "2026-08-15",
      entries: [
        { kind: "Fixed", body: "b" },
        { kind: "Added", body: "a" },
        { kind: "Fixed", body: "c" },
      ],
    });
    expect(block).toBe("## 0.14.0 - 2026-08-15\n### Added\n* a\n### Fixed\n* b\n* c\n");
  });

  it("prepends below the header, leaving prior history untouched", () => {
    const existing = "# Changelog\n\n## 0.13.1 - 2026-08-01\n### Fixed\n* old\n";
    expect(prependChangelogRelease(existing, "## 0.14.0 - 2026-08-15\n### Added\n* new\n")).toBe(
      "# Changelog\n\n## 0.14.0 - 2026-08-15\n### Added\n* new\n\n## 0.13.1 - 2026-08-01\n### Fixed\n* old\n",
    );
  });

  it("renames another tool's first heading to # Changelog and keeps its history below", () => {
    const existing = "# @telorun/kernel\n\n## 0.136.0\n\n### Minor Changes\n\n- abc: a thing\n";
    expect(prependChangelogRelease(existing, "## 0.137.0 - 2026-11-13\n### Added\n* new\n")).toBe(
      "# Changelog\n\n## 0.137.0 - 2026-11-13\n### Added\n* new\n\n## 0.136.0\n\n### Minor Changes\n\n- abc: a thing\n",
    );
  });

  it("writes the skeleton for a unit that has no changelog yet", () => {
    expect(prependChangelogRelease(undefined, "## 0.1.0 - 2026-08-15\n### Added\n* first\n")).toBe(
      "# Changelog\n\n## 0.1.0 - 2026-08-15\n### Added\n* first\n",
    );
  });
});

describe("a Cargo.toml's companion lockfile", () => {
  const handler = new AdapterRegistry(SHIPPED_ADAPTERS).handlerFor("Cargo.toml")!;
  const files: Record<string, string> = {
    "Cargo.lock": 'version = 4\n\n[[package]]\nname = "fx"\nversion = "1.0.0"\n',
    "crates/fx/Cargo.toml": '[package]\nname = "fx"\nversion = "1.1.0"\n',
  };

  it("moves the crate's entry in the nearest lockfile above it", () => {
    expect(handler.companions!("crates/fx/Cargo.toml", "1.1.0", (file) => files[file])).toEqual([
      { file: "Cargo.lock", text: 'version = 4\n\n[[package]]\nname = "fx"\nversion = "1.1.0"\n' },
    ]);
  });

  it("writes nothing when no lockfile records the crate", () => {
    expect(handler.companions!("crates/fx/Cargo.toml", "1.1.0", (file) => (file === "Cargo.lock" ? undefined : files[file]))).toEqual([]);
  });
});
