import { describe, expect, it } from "vitest";
import { stampSelfNpmPins } from "../src/release/version-stamp.js";

/**
 * A module has one version, and an npm-delivered controller's PURL pins the
 * package the module ships itself — so the pin moves with everything else. The
 * rewrite is anchored on the `controllers:` scalars rather than matched in the
 * text, so prose that mentions a PURL is not a rewrite target.
 */
describe("stampSelfNpmPins", () => {
  const manifest = [
    "kind: Telo.Definition",
    "metadata:",
    "  name: Connection",
    "  description: >-",
    "    Delivered as pkg:npm/@telorun/sqlite@0.1.0, because the driver resolves a",
    "    native binary beside its own package.",
    "controllers:",
    "  - pkg:npm/@telorun/sqlite@0.1.0?local_path=./nodejs#connection",
    "",
  ].join("\n");

  it("moves the pin on a controller candidate and keeps its qualifiers", () => {
    const out = stampSelfNpmPins(manifest, "@telorun/sqlite", "0.2.0");
    expect(out).toContain("- pkg:npm/@telorun/sqlite@0.2.0?local_path=./nodejs#connection");
  });

  it("leaves a PURL written in prose alone", () => {
    const out = stampSelfNpmPins(manifest, "@telorun/sqlite", "0.2.0");
    // A free text match would have rewritten the description too, silently
    // editing a sentence that was describing the shape rather than pinning it.
    expect(out).toContain("Delivered as pkg:npm/@telorun/sqlite@0.1.0, because");
  });

  it("leaves a candidate naming someone else's package untouched", () => {
    const other = "controllers:\n  - pkg:npm/left-pad@1.0.0?local_path=./nodejs#x\n";
    expect(stampSelfNpmPins(other, "@telorun/sqlite", "0.2.0")).toBe(other);
  });

  it("returns the text unchanged when the pin is already the version", () => {
    expect(stampSelfNpmPins(manifest, "@telorun/sqlite", "0.1.0")).toBe(manifest);
  });

  it("rewrites every document that names the package", () => {
    const two = [manifest, "---", "kind: Telo.Definition", "controllers:", "  - pkg:npm/@telorun/sqlite@0.1.0#table", ""].join("\n");
    const out = stampSelfNpmPins(two, "@telorun/sqlite", "0.3.0");
    expect(out).toContain("pkg:npm/@telorun/sqlite@0.3.0?local_path=./nodejs#connection");
    expect(out).toContain("pkg:npm/@telorun/sqlite@0.3.0#table");
  });
});
