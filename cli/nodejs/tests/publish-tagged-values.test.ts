import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { defaultCustomTags } from "@telorun/templating";
import { ModulePayloadBuilder } from "../src/bundle/module-payload.js";
import { expandAndInlineIncludes } from "../src/bundle/manifest-text.js";

let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-publish-test-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("expandAndInlineIncludes — tagged values", () => {
  it("preserves !cel and !literal tags inlined from a partial file", () => {
    fs.writeFileSync(
      path.join(workdir, "telo.yaml"),
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "include:",
        "  - ./partial.yaml",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(workdir, "partial.yaml"),
      [
        "kind: Run.Sequence",
        "metadata:",
        "  name: TaggedSeq",
        "steps:",
        "  - name: ComputeStep",
        "    inputs:",
        "      computed: !cel 'variables.port'",
        "      raw: !literal 'Hello ${{ x }}'",
        "    invoke:",
        "      kind: Some.Action",
        "",
      ].join("\n"),
    );

    const owner = fs.readFileSync(path.join(workdir, "telo.yaml"), "utf-8");
    const out = expandAndInlineIncludes(owner, workdir);

    // Re-parse the inlined output with the same customTags and verify the
    // sentinels survived the include-expansion mutation pipeline.
    const docs = parseAllDocuments(out, { customTags: defaultCustomTags() });
    const reparsed = docs.map((d) => d.toJSON());
    expect(reparsed).toHaveLength(2);
    const seq = reparsed[1] as { steps: { inputs: Record<string, unknown> }[] };
    expect(seq.steps[0].inputs.computed).toEqual({
      __tagged: true,
      engine: "cel",
      source: "variables.port",
    });
    expect(seq.steps[0].inputs.raw).toEqual({
      __tagged: true,
      engine: "literal",
      source: "Hello ${{ x }}",
    });

    // The owner doc's `include` directive must be removed from the output.
    expect(out).not.toMatch(/^\s*include:/m);
  });

  it("preserves a tagged value already present in the owner manifest", () => {
    fs.writeFileSync(
      path.join(workdir, "telo.yaml"),
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "include:",
        "  - ./partial.yaml",
        "---",
        "kind: Some.Resource",
        "metadata:",
        "  name: r",
        "config: !cel 'variables.cfg'",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(workdir, "partial.yaml"), "kind: Some.Other\nmetadata:\n  name: o\n");

    const owner = fs.readFileSync(path.join(workdir, "telo.yaml"), "utf-8");
    const out = expandAndInlineIncludes(owner, workdir);

    const docs = parseAllDocuments(out, { customTags: defaultCustomTags() });
    const ownerResource = docs
      .map((d) => d.toJSON() as Record<string, unknown> | null)
      .find((d) => d?.kind === "Some.Resource") as Record<string, unknown> | undefined;
    expect(ownerResource?.config).toEqual({
      __tagged: true,
      engine: "cel",
      source: "variables.cfg",
    });
  });
});

describe("ModulePayloadBuilder — canonicalization and tagged values", () => {
  it("preserves tagged values in non-import documents while rewriting the imports source", async () => {
    // Two sibling modules, so the relative import resolves to a Library and is
    // rewritten to the sibling's published ref plus a pin derived from the
    // sibling's OWN published bytes — never fetched.
    const consumerDir = path.join(workdir, "consumer");
    const libDir = path.join(workdir, "lib");
    fs.mkdirSync(consumerDir, { recursive: true });
    fs.mkdirSync(libDir, { recursive: true });

    fs.writeFileSync(
      path.join(libDir, "telo.yaml"),
      ["kind: Telo.Library", "metadata:", "  name: somelib", "  version: 2.5.1", ""].join("\n"),
    );

    const consumerManifestPath = path.join(consumerDir, "telo.yaml");
    fs.writeFileSync(
      consumerManifestPath,
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "imports:",
        "  SomeLib: ../lib",
        "---",
        "kind: Some.Resource",
        "metadata:",
        "  name: r",
        "computed: !cel 'variables.port'",
        "raw: !literal 'before-${{ x }}-after'",
        "",
      ].join("\n"),
    );

    const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") });
    // The destination is this module's own published location, so a sibling
    // lands beside it — `../lib` under `…/test/app` resolves to `…/test/lib`.
    const payload = await builder.payload(
      consumerManifestPath,
      "oci://registry.example/test/app",
    );

    expect(payload.relativeImports.map((entry) => entry.ref)).toEqual([
      "oci://registry.example/test/lib@2.5.1",
    ]);

    const docs = parseAllDocuments(payload.manifest, { customTags: defaultCustomTags() });
    const json = docs
      .map((d) => d.toJSON() as Record<string, unknown> | null)
      .filter((d): d is Record<string, unknown> => d !== null);

    const appDoc = json.find((d) => d.kind === "Telo.Application") as {
      imports?: Record<string, string>;
    };
    // The ref, plus the pin derived from the sibling's local published bytes.
    expect(appDoc.imports?.SomeLib).toMatch(
      /^oci:\/\/registry\.example\/test\/lib@2\.5\.1#sha256-[\w-]+$/,
    );

    const resource = json.find((d) => d.kind === "Some.Resource") as Record<string, unknown>;
    expect(resource.computed).toEqual({
      __tagged: true,
      engine: "cel",
      source: "variables.port",
    });
    expect(resource.raw).toEqual({
      __tagged: true,
      engine: "literal",
      source: "before-${{ x }}-after",
    });
  });

  it("re-serializes unconditionally, so bytes do not depend on whether a pin was written", async () => {
    // The old transform returned the input verbatim when nothing was rewritten,
    // which made the published bytes a function of the manifest's own content
    // rather than of the manifest. Two runs must agree, and the output must be
    // the canonical serialization either way.
    const manifestPath = path.join(workdir, "telo.yaml");
    const text = [
      "kind: Telo.Application",
      "metadata:",
      "  name: app",
      "  version: 1.0.0",
      "---",
      "kind: Some.Resource",
      "metadata:",
      "  name: r",
      "computed: !cel 'variables.port'",
      "",
    ].join("\n");
    fs.writeFileSync(manifestPath, text);

    const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") });
    const first = await builder.payload(manifestPath, "oci://registry.example/test/app");
    const second = await new ModulePayloadBuilder({
      cacheRoot: path.join(workdir, ".telo2"),
    }).payload(manifestPath, "oci://registry.example/test/app");
    expect(first.manifest).toBe(second.manifest);
    expect(first.manifest).toContain("computed: !cel 'variables.port'");
  });

  it("refuses a remote import the author left unpinned", async () => {
    const manifestPath = path.join(workdir, "telo.yaml");
    fs.writeFileSync(
      manifestPath,
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "imports:",
        "  Console: oci://ghcr.io/telorun/console@0.17.0",
        "",
      ].join("\n"),
    );
    const builder = new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") });
    await expect(
      builder.payload(manifestPath, "oci://registry.example/test/app"),
    ).rejects.toThrow(/no integrity pin/);
  });
});

describe("ModulePayloadBuilder — authored pins", () => {
  /** A module with one remote import, written in the scalar or the object form.
   *  Both are pins; they differ only in where the hash sits, which is exactly
   *  what the payload record exists to erase for its consumers. */
  function withImport(lines: string[]): string {
    const manifestPath = path.join(workdir, "telo.yaml");
    fs.writeFileSync(
      manifestPath,
      ["kind: Telo.Application", "metadata:", "  name: app", "  version: 1.0.0", "imports:", ...lines, ""].join(
        "\n",
      ),
    );
    return manifestPath;
  }

  const HASH = "sha256-rsHTBqyhpYZYEOIW15suoUwTTjzzOeDztioTqLQJyyU";

  it("reports a SCALAR-form pin with its ref and hash split apart", async () => {
    // The regression this covers: the record used to carry only a ref with the
    // fragment already stripped, so publish's verification re-split it, found
    // nothing, and skipped — silently, for every pin in the repo, which is every
    // pin written this way.
    const manifestPath = withImport([`  Console: oci://ghcr.io/telorun/console@0.17.0#${HASH}`]);
    const payload = await new ModulePayloadBuilder({
      cacheRoot: path.join(workdir, ".telo"),
    }).payload(manifestPath, "oci://registry.example/test/app");

    expect(payload.authoredPins).toEqual([
      { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0", integrity: HASH },
    ]);
  });

  it("reports an OBJECT-form pin identically", async () => {
    const manifestPath = withImport([
      "  Console:",
      "    source: oci://ghcr.io/telorun/console@0.17.0",
      `    integrity: ${HASH}`,
    ]);
    const payload = await new ModulePayloadBuilder({
      cacheRoot: path.join(workdir, ".telo"),
    }).payload(manifestPath, "oci://registry.example/test/app");

    expect(payload.authoredPins).toEqual([
      { alias: "Console", ref: "oci://ghcr.io/telorun/console@0.17.0", integrity: HASH },
    ]);
  });

  it("does not report a sibling-derived pin", async () => {
    // It was computed from local bytes the registry has not seen yet — the batch
    // pushes dependencies first precisely so it does not have to have.
    const libDir = path.join(workdir, "lib");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(
      path.join(libDir, "telo.yaml"),
      ["kind: Telo.Library", "metadata:", "  name: somelib", "  version: 2.5.1", ""].join("\n"),
    );
    const consumerDir = path.join(workdir, "consumer");
    fs.mkdirSync(consumerDir, { recursive: true });
    const manifestPath = path.join(consumerDir, "telo.yaml");
    fs.writeFileSync(
      manifestPath,
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "imports:",
        "  SomeLib: ../lib",
        "",
      ].join("\n"),
    );

    const payload = await new ModulePayloadBuilder({
      cacheRoot: path.join(workdir, ".telo"),
    }).payload(manifestPath, "oci://registry.example/test/app");

    expect(payload.authoredPins).toEqual([]);
    expect(payload.relativeImports).toHaveLength(1);
  });
});

describe("ModulePayloadBuilder — the payload guard", () => {
  it("names every missing file, aggregated", async () => {
    // `partitionLayers` puts a claimed path into a layer whether or not the file
    // is there — membership is a manifest question and it has no filesystem — so
    // the guard is what stops an artifact whose manifest reads a file the payload
    // does not carry, a failure that otherwise surfaces on a consumer's machine.
    const manifestPath = path.join(workdir, "telo.yaml");
    fs.writeFileSync(
      manifestPath,
      [
        "kind: Telo.Library",
        "metadata:",
        "  name: lib",
        "  version: 1.0.0",
        "---",
        "kind: Some.Resource",
        "metadata:",
        "  name: r",
        "payload: !include-bytes assets/missing.bin",
        "",
      ].join("\n"),
    );

    await expect(
      new ModulePayloadBuilder({ cacheRoot: path.join(workdir, ".telo") }).payload(
        manifestPath,
        "oci://registry.example/test/lib",
      ),
    ).rejects.toThrow(/names 1 file\(s\) that do not exist: assets\/missing\.bin/);
  });
});
