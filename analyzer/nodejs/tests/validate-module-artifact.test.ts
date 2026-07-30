import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { validateModuleArtifact } from "../src/validate-module-artifact.js";

const definition = (name: string, controllers: string[]): ResourceManifest =>
  ({
    kind: "Telo.Definition",
    metadata: { name, module: "demo", source: "file:///demo/telo.yaml" },
    controllers,
  }) as unknown as ResourceManifest;

const owner = (layers: unknown): ResourceManifest =>
  ({
    kind: "Telo.Library",
    metadata: { name: "demo", source: "file:///demo/telo.yaml" },
    layers,
  }) as unknown as ResourceManifest;

const codes = (manifests: ResourceManifest[]) =>
  validateModuleArtifact(manifests).map((d) => d.code);

const VALID_BLOB = `sha256:${"a".repeat(64)}`;
const VALID_INTEGRITY = `sha256-${"A".repeat(43)}`;

describe("controller selector qualifiers", () => {
  it("accepts the known qualifiers", () => {
    expect(
      codes([
        definition("K", [
          "pkg:telo/local/napi?path=./rust/c.node&os=linux&arch=amd64&libc=gnu&siblings=./rust/*.so",
        ]),
      ]),
    ).toEqual([]);
  });

  // The whole reason this check exists: an ignored typo makes the candidate
  // platform-neutral, so publish emits one layer and every host loads a binary
  // built for one architecture — with no error, ever.
  it("rejects a mistyped platform axis rather than silently ignoring it", () => {
    expect(
      codes([definition("K", ["pkg:telo/local/napi?path=./rust/c.node&architecture=arm64"])]),
    ).toEqual(["CONTROLLER_UNKNOWN_QUALIFIER"]);
  });

  it("rejects a selector value outside the canonical token grammar", () => {
    expect(codes([definition("K", ["pkg:telo/local/napi?path=./c.node&os=Linux!"])])).toEqual([
      "CONTROLLER_INVALID_SELECTOR",
    ]);
  });

  it("normalizes case rather than rejecting it", () => {
    expect(codes([definition("K", ["pkg:telo/local/napi?path=./c.node&os=Linux"])])).toEqual([]);
  });

  // Several candidates sharing one selector is the designed shape, not an error:
  // that layer holds every one of their entry points (spec §1), which is what any
  // module with two `js` controllers relies on.
  it("accepts several candidates sharing one selector", () => {
    expect(
      codes([
        definition("A", ["pkg:telo/local/js?path=./nodejs/a.mjs"]),
        definition("B", ["pkg:telo/local/js?path=./nodejs/b.mjs"]),
      ]),
    ).toEqual([]);
  });

  it("accepts a same-format fallback inside one candidate list", () => {
    expect(
      codes([
        definition("A", [
          "pkg:telo/local/js?path=./primary.mjs#p",
          "pkg:telo/local/js?path=./fallback.mjs#f",
        ]),
      ]),
    ).toEqual([]);
  });

  it("ignores candidates that are not bundled controllers", () => {
    expect(
      codes([definition("K", ["pkg:npm/@telorun/run@1.0.0?local_path=./nodejs&weird=1#run"])]),
    ).toEqual([]);
  });
});

describe("published layer index", () => {
  it("accepts a well-formed index", () => {
    expect(
      codes([
        owner([
          { role: "controller", selector: { format: "js" }, blob: VALID_BLOB, integrity: VALID_INTEGRITY },
          { role: "assets", blob: VALID_BLOB, integrity: VALID_INTEGRITY },
        ]),
      ]),
    ).toEqual([]);
  });

  it("reports a controller layer with no selector", () => {
    expect(codes([owner([{ role: "controller", blob: VALID_BLOB, integrity: VALID_INTEGRITY }])])).toEqual(
      ["INVALID_LAYER_INDEX"],
    );
  });

  it("reports a singleton layer carrying a selector", () => {
    expect(
      codes([
        owner([
          { role: "assets", selector: { format: "js" }, blob: VALID_BLOB, integrity: VALID_INTEGRITY },
        ]),
      ]),
    ).toEqual(["INVALID_LAYER_INDEX"]);
  });

  it("reports two layers claiming one selector", () => {
    expect(
      codes([
        owner([
          { role: "controller", selector: { format: "js" }, blob: VALID_BLOB, integrity: VALID_INTEGRITY },
          { role: "controller", selector: { format: "js" }, blob: VALID_BLOB, integrity: VALID_INTEGRITY },
        ]),
      ]),
    ).toEqual(["INVALID_LAYER_INDEX"]);
  });

  // `os: Linux` satisfies the JSON Schema (it is a string) and throws from the
  // parser at runtime — exactly the gap the schema alone cannot close.
  it("reports a selector value the schema accepts but the grammar rejects", () => {
    expect(
      codes([
        owner([
          {
            role: "controller",
            selector: { format: "napi", os: "Linux!" },
            blob: VALID_BLOB,
            integrity: VALID_INTEGRITY,
          },
        ]),
      ]),
    ).toEqual(["INVALID_LAYER_INDEX"]);
  });

  it("reports a malformed digest", () => {
    expect(
      codes([owner([{ role: "assets", blob: "sha256:nope", integrity: VALID_INTEGRITY }])]),
    ).toEqual(["INVALID_LAYER_INDEX"]);
  });

  it("says nothing about an unpublished manifest with no index", () => {
    expect(codes([owner(undefined)])).toEqual([]);
  });
});
