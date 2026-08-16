import { describe, expect, it } from "vitest";
import { prependChangelogRelease, renderChangelogRelease } from "../src/release/changelog.js";
import {
  readManifestVersion,
  stampCrateVersion,
  stampManifestVersion,
  stampPackageVersion,
} from "../src/release/version-stamp.js";

describe("stampManifestVersion", () => {
  const manifest = [
    "kind: Telo.Library",
    "metadata:",
    "  name: SQL",
    "  version: 0.13.1",
    "  description: >-",
    "    A folded block scalar that a re-serializer would reflow.",
    "---",
    "kind: Telo.Definition",
    "metadata:",
    "  name: Query",
    "  version: 9.9.9",
    "",
  ].join("\n");

  it("writes the module doc's version and touches nothing else", () => {
    const out = stampManifestVersion(manifest, "0.14.0", "telo.yaml")!;
    expect(out).toContain("  version: 0.14.0");
    // The block scalar survives byte-for-byte: a re-serializer would refold it.
    expect(out).toContain("  description: >-\n    A folded block scalar");
    // A `version` further down the file is a different document's field and is
    // not the module's version — the regex-replacement changie was configured
    // with matched by line shape, which is why it needed a hand-maintained count
    // of how many lines it was allowed to hit.
    expect(out).toContain("  version: 9.9.9");
  });

  it("preserves the author's quote style", () => {
    const quoted = 'kind: Telo.Library\nmetadata:\n  name: X\n  version: "0.1.0"\n';
    expect(stampManifestVersion(quoted, "0.2.0", "telo.yaml")).toContain('version: "0.2.0"');
  });

  it("returns undefined when the module doc declares no version", () => {
    expect(
      stampManifestVersion("kind: Telo.Library\nmetadata:\n  name: X\n", "1.0.0", "telo.yaml"),
    ).toBeUndefined();
  });
});

describe("readManifestVersion", () => {
  it("reads only a module doc's version", () => {
    expect(readManifestVersion("kind: Telo.Library\nmetadata:\n  version: 1.2.3\n")).toBe("1.2.3");
    // A non-module doc is not a module, however versioned it looks — the looser
    // rule would read `apps/hub/test-suite-e2e.yaml` as a second module.
    expect(readManifestVersion("kind: Test.Suite\nmetadata:\n  version: 1.0.0\n")).toBeUndefined();
  });
});

describe("stampPackageVersion", () => {
  it("rewrites the top-level version and leaves formatting alone", () => {
    const json = '{\n  "name": "@telorun/sql",\n  "version": "0.12.1",\n  "private": false\n}\n';
    const out = stampPackageVersion(json, "0.14.0", "package.json")!;
    expect(out).toBe('{\n  "name": "@telorun/sql",\n  "version": "0.14.0",\n  "private": false\n}\n');
  });

  it("ignores a nested version, which belongs to a dependency", () => {
    const json = '{\n  "name": "x",\n  "dependencies": { "version": "9.9.9" }\n}\n';
    expect(stampPackageVersion(json, "1.0.0", "package.json")).toBeUndefined();
  });
});

describe("stampCrateVersion", () => {
  it("rewrites [package].version only", () => {
    const toml = [
      "[package]",
      'name = "telorun-sql"',
      'version = "0.0.0"',
      "",
      "[dependencies]",
      'serde = { version = "1.0" }',
      "",
    ].join("\n");
    const out = stampCrateVersion(toml, "0.14.0", "Cargo.toml")!;
    expect(out).toContain('version = "0.14.0"');
    expect(out).toContain('serde = { version = "1.0" }');
  });

  it("leaves a workspace-inherited version alone", () => {
    const toml = "[package]\nname = \"x\"\nversion.workspace = true\n";
    expect(stampCrateVersion(toml, "1.0.0", "Cargo.toml")).toBeUndefined();
  });

  it("returns undefined when there is no [package] table", () => {
    expect(stampCrateVersion("[workspace]\nmembers = []\n", "1.0.0", "Cargo.toml")).toBeUndefined();
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
    const out = prependChangelogRelease(existing, "## 0.14.0 - 2026-08-15\n### Added\n* new\n");
    expect(out).toBe(
      "# Changelog\n\n## 0.14.0 - 2026-08-15\n### Added\n* new\n\n## 0.13.1 - 2026-08-01\n### Fixed\n* old\n",
    );
  });

  it("writes the skeleton for a module that has no changelog yet", () => {
    expect(prependChangelogRelease(undefined, "## 0.1.0 - 2026-08-15\n### Added\n* first\n")).toBe(
      "# Changelog\n\n## 0.1.0 - 2026-08-15\n### Added\n* first\n",
    );
  });
});
