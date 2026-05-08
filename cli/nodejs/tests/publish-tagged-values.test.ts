import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Loader } from "@telorun/analyzer";
import { LocalFileSource } from "@telorun/kernel";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { defaultCustomTags } from "@telorun/templating";
import {
  canonicalizeRelativeImports,
  expandAndInlineIncludes,
} from "../src/commands/publish.js";

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

describe("canonicalizeRelativeImports — tagged values", () => {
  it("preserves tagged values in non-import documents while rewriting Telo.Import.source", async () => {
    // Set up two sibling modules so canonicalizeRelativeImports can resolve
    // the relative import to a Library and rewrite the source.
    const consumerDir = path.join(workdir, "consumer");
    const libDir = path.join(workdir, "lib");
    fs.mkdirSync(consumerDir, { recursive: true });
    fs.mkdirSync(libDir, { recursive: true });

    fs.writeFileSync(
      path.join(libDir, "telo.yaml"),
      [
        "kind: Telo.Library",
        "metadata:",
        "  namespace: test",
        "  name: somelib",
        "  version: 2.5.1",
        "",
      ].join("\n"),
    );

    const consumerManifestPath = path.join(consumerDir, "telo.yaml");
    fs.writeFileSync(
      consumerManifestPath,
      [
        "kind: Telo.Application",
        "metadata:",
        "  name: app",
        "  version: 1.0.0",
        "---",
        "kind: Telo.Import",
        "metadata:",
        "  name: SomeLib",
        "source: ../lib",
        "---",
        "kind: Some.Resource",
        "metadata:",
        "  name: r",
        "computed: !cel 'variables.port'",
        "raw: !literal 'before-${{ x }}-after'",
        "",
      ].join("\n"),
    );

    const owner = fs.readFileSync(consumerManifestPath, "utf-8");
    const localFileSource = new LocalFileSource();
    const loader = new Loader([localFileSource]);
    const out = await canonicalizeRelativeImports(
      owner,
      consumerManifestPath,
      loader,
      localFileSource,
    );

    // Re-parse and verify:
    //   1. Tagged values in `Some.Resource` survived the doc.setIn(["source"]) mutation.
    //   2. Telo.Import.source was canonicalized to `<namespace>/<name>@<version>`.
    const docs = parseAllDocuments(out, { customTags: defaultCustomTags() });
    const json = docs
      .map((d) => d.toJSON() as Record<string, unknown> | null)
      .filter((d): d is Record<string, unknown> => d !== null);

    const importDoc = json.find((d) => d.kind === "Telo.Import") as { source?: string };
    expect(importDoc.source).toBe("test/somelib@2.5.1");

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

  it("returns the input unchanged when no relative imports are present", async () => {
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

    const localFileSource = new LocalFileSource();
    const loader = new Loader([localFileSource]);
    void pathToFileURL(manifestPath);
    const out = await canonicalizeRelativeImports(text, manifestPath, loader, localFileSource);
    // No imports → no mutation → returned content is identical.
    expect(out).toBe(text);
  });
});
