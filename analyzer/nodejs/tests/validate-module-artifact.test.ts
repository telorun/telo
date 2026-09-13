import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { validateModuleArtifact } from "../src/validate-module-artifact.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

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

  it("requires a dylib candidate to state a telo-family abi, at the candidate", () => {
    const diagnostics = validateModuleArtifact([
      definition("K", [
        "pkg:telo/local/dylib?path=./rust/a.so&os=linux&arch=amd64",
        "pkg:telo/local/dylib?path=./rust/b.so&os=linux&arch=amd64&abi=node-137",
        "pkg:telo/local/dylib?path=./rust/c.so&os=linux&arch=amd64&abi=telo-2",
      ]),
    ]);
    expect(diagnostics.map((d) => [d.code, d.data?.path])).toEqual([
      ["CONTROLLER_DYLIB_ABI_MISSING", "controllers[0]"],
      ["CONTROLLER_DYLIB_ABI_MISSING", "controllers[1]"],
    ]);
  });

  it("reports an N-API abi and a libc off linux at a controller candidate and an exports.code entry", () => {
    const diagnostics = validateModuleArtifact([
      {
        kind: "Telo.Library",
        metadata: { name: "demo", source: "file:///demo/telo.yaml" },
        exports: {
          code: [{ specifier: "demo", format: "napi", path: "./demo.node", os: "darwin", libc: "gnu" }],
        },
      } as unknown as ResourceManifest,
      definition("K", ["pkg:telo/local/napi?path=./c.node&os=linux&abi=node-137"]),
    ]);
    expect(diagnostics.map((d) => [d.code, d.data?.path])).toEqual([
      ["LIBRARY_LIBC_OFF_LINUX", "exports/code"],
      ["CONTROLLER_NAPI_ABI_FORBIDDEN", "controllers[0]?abi"],
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

describe("the abi axis", () => {
  it("is accepted on a controller candidate, an exports.code entry and a layer selector", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([
        {
          kind: "Telo.Library",
          metadata: { name: "Demo", module: "Demo", source: "file:///demo/telo.yaml" },
          exports: {
            code: [{ specifier: "demo", format: "node", path: "./demo.node", abi: "node-137" }],
          },
          layers: [
            {
              role: "controller",
              selector: { format: "node", abi: "node-137" },
              blob: VALID_BLOB,
              integrity: VALID_INTEGRITY,
            },
          ],
        },
        {
          kind: "Telo.Definition",
          metadata: { name: "Thing", module: "Demo", source: "file:///demo/telo.yaml" },
          capability: "Telo.Invocable",
          controllers: ["pkg:telo/local/node?path=./demo.node&os=linux&abi=node-137"],
        },
      ] as unknown as ResourceManifest[]),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  // A bare number cannot say whose ABI it is, and a published value cannot be
  // requalified later.
  it("refuses a value outside <family>-<version> wherever a selector is read", () => {
    const diagnostics = validateModuleArtifact([
      {
        kind: "Telo.Library",
        metadata: { name: "demo", source: "file:///demo/telo.yaml" },
        exports: { code: [{ specifier: "demo", format: "node", path: "./demo.node", abi: "137" }] },
        layers: [
          {
            role: "controller",
            selector: { format: "node", abi: "137" },
            blob: VALID_BLOB,
            integrity: VALID_INTEGRITY,
          },
        ],
      } as unknown as ResourceManifest,
      definition("K", ["pkg:telo/local/node?path=./demo.node&abi=137"]),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual([
      "INVALID_LAYER_INDEX",
      "LIBRARY_CANDIDATE_INVALID",
      "CONTROLLER_INVALID_SELECTOR",
    ]);
    for (const d of diagnostics) expect(d.message).toContain("<family>-<version>");
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

  // The owner doc's schema is the other half of `telo check`: an entry the parser
  // skips must not be rejected by the schema instead.
  it("reports nothing for an entry with an unknown role or an unknown selector axis", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([
        {
          kind: "Telo.Library",
          metadata: { name: "Demo", module: "Demo", source: "file:///demo/telo.yaml" },
          layers: [
            { role: "controller", selector: { format: "js" }, blob: VALID_BLOB, integrity: VALID_INTEGRITY },
            { role: "firmware", selector: { format: "node" }, blob: VALID_BLOB, integrity: VALID_INTEGRITY },
            {
              role: "controller",
              selector: { format: "js", gpu: "cuda" },
              blob: VALID_BLOB,
              integrity: VALID_INTEGRITY,
            },
          ],
        },
      ] as unknown as ResourceManifest[]),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  // A runtime that cannot name a role reads only its role and digests (spec §3.1).
  it("reports nothing for the selector of an entry with an unknown role", () => {
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions([
        {
          kind: "Telo.Library",
          metadata: { name: "Demo", module: "Demo", source: "file:///demo/telo.yaml" },
          layers: [
            { role: "firmware", selector: { gpu: "cuda" }, blob: VALID_BLOB, integrity: VALID_INTEGRITY },
          ],
        },
      ] as unknown as ResourceManifest[]),
    );
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });

  it("reports a known-role selector with no format", () => {
    expect(
      codes([
        owner([
          { role: "controller", selector: { os: "linux" }, blob: VALID_BLOB, integrity: VALID_INTEGRITY },
        ]),
      ]),
    ).toEqual(["INVALID_LAYER_INDEX"]);
  });

  it("says nothing about an unpublished manifest with no index", () => {
    expect(codes([owner(undefined)])).toEqual([]);
  });
});
