import { describe, expect, it } from "vitest";
import { readManifestVersion, stampManifestVersion } from "../src/release/version-stamp.js";

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
