import { collectModuleFileClaims, selectorKey } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import { describePartition, partitionLayers } from "../src/bundle/partition-layers.js";

/** A manifest declaring bundled controllers, reduced to the claims
 *  `partitionLayers` consumes. The tests still speak manifest text — that is
 *  what an author writes — but the partition itself no longer parses one: it
 *  recognises neither a PURL nor a YAML tag, and `collectModuleFileClaims` is
 *  the single reader that does. */
function manifest(...controllers: string[]): ReturnType<typeof collectModuleFileClaims> {
  return collectModuleFileClaims(
    [
      "kind: Telo.Library\nmetadata:\n  name: demo\n  version: 1.0.0\n",
      ...controllers.map(
        (purl, i) =>
          `---\nkind: Telo.Definition\nmetadata:\n  name: K${i}\ncontrollers:\n  - ${purl}\n`,
      ),
    ].join(""),
  );
}

/** A manifest whose resource embeds a file with `!include-*`. */
function manifestWithEmbed(tag: string, filePath: string) {
  return collectModuleFileClaims(
    "kind: Telo.Library\nmetadata:\n  name: demo\n  version: 1.0.0\n" +
      `---\nkind: Demo.Thing\nmetadata:\n  name: t\nasset: !${tag} ${filePath}\n`,
  );
}

const layerFor = (p: ReturnType<typeof partitionLayers>, key: string) =>
  p.layers.find((l) => (l.selector ? selectorKey(l.selector) : l.role) === key);

describe("partitionLayers", () => {
  it("gives each controller selector its own layer, keyed by the PURL's platform qualifiers", () => {
    const p = partitionLayers(
      manifest(
        "pkg:telo/local/js?path=./nodejs/c.mjs",
        "pkg:telo/local/napi?path=./rust/c-linux.node&os=linux&arch=amd64&libc=gnu",
        "pkg:telo/local/napi?path=./rust/c-darwin.node&os=darwin&arch=arm64",
      ),
      ["nodejs/c.mjs", "rust/c-linux.node", "rust/c-darwin.node"],
      [],
    );

    expect(layerFor(p, "format=js")?.files).toEqual(["nodejs/c.mjs"]);
    expect(layerFor(p, "arch=amd64;format=napi;libc=gnu;os=linux")?.files).toEqual([
      "rust/c-linux.node",
    ]);
    expect(layerFor(p, "arch=arm64;format=napi;os=darwin")?.files).toEqual(["rust/c-darwin.node"]);
    // Everything was claimed, so there is nothing to sink.
    expect(layerFor(p, "common")).toBeUndefined();
  });

  it("groups candidates sharing one selector into one layer", () => {
    const p = partitionLayers(
      manifest("pkg:telo/local/js?path=./nodejs/a.mjs", "pkg:telo/local/js?path=./nodejs/b.mjs"),
      ["nodejs/a.mjs", "nodejs/b.mjs"],
      [],
    );
    expect(p.layers).toHaveLength(1);
    expect(layerFor(p, "format=js")?.files).toEqual(["nodejs/a.mjs", "nodejs/b.mjs"]);
  });

  it("claims a sibling into its candidate's layer, keeping it off other platforms", () => {
    const p = partitionLayers(
      manifest("pkg:telo/local/js?path=./pkg/glue.mjs&siblings=./pkg/*.wasm"),
      ["pkg/glue.mjs", "pkg/mod.wasm"],
      [],
    );
    expect(layerFor(p, "format=js")?.files).toEqual(["pkg/glue.mjs", "pkg/mod.wasm"]);
    expect(layerFor(p, "common")).toBeUndefined();
  });

  it("puts author-claimed assets in their own lazily fetched layer", () => {
    const p = partitionLayers(
      manifest("pkg:telo/local/js?path=./nodejs/c.mjs"),
      ["nodejs/c.mjs", "public/index.html", "public/app.js"],
      ["public/**"],
    );
    expect(layerFor(p, "assets")?.files).toEqual(["public/app.js", "public/index.html"]);
    expect(layerFor(p, "common")).toBeUndefined();
  });

  // The sink rule: unclaimed files go where every controller-hosting kernel will
  // fetch them, so a forgotten declaration costs bytes and never a broken import.
  it("sinks unclaimed files into the common layer, not into assets", () => {
    const p = partitionLayers(
      manifest("pkg:telo/local/js?path=./nodejs/c.mjs"),
      ["nodejs/c.mjs", "pkg/mod.wasm", "public/index.html"],
      [],
    );
    expect(layerFor(p, "format=js")?.files).toEqual(["nodejs/c.mjs"]);
    expect(layerFor(p, "common")?.files).toEqual(["pkg/mod.wasm", "public/index.html"]);
    expect(layerFor(p, "assets")).toBeUndefined();
  });

  it("ignores non-bundled controller candidates", () => {
    const p = partitionLayers(
      manifest("pkg:npm/@telorun/run@1.0.0?local_path=./nodejs#run"),
      ["nodejs/index.js"],
      [],
    );
    expect(p.layers.map((l) => l.role)).toEqual(["common"]);
  });

  it("drops empty layers so a controller-only module publishes exactly one", () => {
    const p = partitionLayers(
      manifest("pkg:telo/local/js?path=./nodejs/c.mjs"),
      ["nodejs/c.mjs"],
      [],
    );
    expect(p.layers).toHaveLength(1);
    expect(describePartition(p)).toEqual(["controller js: 1 file(s)"]);
  });

  it("reports a payload-less module as no layers at all", () => {
    expect(partitionLayers(manifest(), [], []).layers).toEqual([]);
  });

  // `controllers:` already names the entry point, so `files:` restating it would
  // be pure duplication. It joins the payload from the PURL, and `files:` keeps
  // its role for what the manifest cannot otherwise see.
  it("adds a controller entry point that files: does not select", () => {
    const p = partitionLayers(
      manifest("pkg:telo/local/js?path=./nodejs/c.mjs"),
      ["public/x.html"],
      [],
    );
    expect(p.layers).toEqual([
      { role: "controller", selector: { format: "js" }, files: ["nodejs/c.mjs"] },
      { role: "common", files: ["public/x.html"] },
    ]);
  });

  // A module whose only payload is its controller declares no `files:` at all.
  it("builds a controller layer from a manifest with no files: block", () => {
    const p = partitionLayers(manifest("pkg:telo/local/js?path=./nodejs/c.mjs"), [], []);
    expect(p.layers).toEqual([
      { role: "controller", selector: { format: "js" }, files: ["nodejs/c.mjs"] },
    ]);
  });

  // A file two candidates both declare is copied into both layers. Taking it for
  // whichever came first would leave the second platform's layer missing a file it
  // declared it needs — and it is claimed, so the common-layer sink never sees it.
  it("copies a multiply-claimed sibling into every claiming layer", () => {
    const p = partitionLayers(
      manifest(
        "pkg:telo/local/napi?path=./native/linux.node&os=linux&arch=amd64&siblings=./native/*.so",
        "pkg:telo/local/napi?path=./native/darwin.node&os=darwin&arch=arm64&siblings=./native/*.so",
      ),
      ["native/linux.node", "native/darwin.node", "native/libshared.so"],
      [],
    );
    expect(layerFor(p, "arch=amd64;format=napi;os=linux")?.files).toEqual([
      "native/libshared.so",
      "native/linux.node",
    ]);
    expect(layerFor(p, "arch=arm64;format=napi;os=darwin")?.files).toEqual([
      "native/darwin.node",
      "native/libshared.so",
    ]);
    expect(layerFor(p, "common")).toBeUndefined();
  });

  // An empty layer is dropped, so without this the author's only feedback channel
  // is silent about the one mistake it exists to catch.
  it("reports assets and siblings patterns that matched nothing", () => {
    const p = partitionLayers(
      manifest("pkg:telo/local/js?path=./nodejs/c.mjs&siblings=./pkg/*.wasm"),
      ["nodejs/c.mjs"],
      ["pubic/**"],
    );
    expect(p.unmatchedAssets).toEqual(["pubic/**"]);
    expect(p.unmatchedSiblings).toEqual([
      {
        origin: "pkg:telo/local/js?path=./nodejs/c.mjs&siblings=./pkg/*.wasm",
        pattern: "./pkg/*.wasm",
      },
    ]);
    expect(describePartition(p)).toContain("assets pattern 'pubic/**' matched no file");
  });

  it("puts a file an `!include-*` tag embeds into the assets layer, with no assets: pattern", () => {
    // The manifest names the file, so it is claimed for the same reason a
    // controller's `path=` entry is — and lazily, because an embed is read when
    // the resource holding it is created rather than at load.
    const p = partitionLayers(manifestWithEmbed("include-bytes", "assets/logo.png"), [], []);
    expect(layerFor(p, "assets")?.files).toEqual(["assets/logo.png"]);
    expect(layerFor(p, "common")).toBeUndefined();
  });

  it("claims an embedded file that `files:` did not select", () => {
    const p = partitionLayers(manifestWithEmbed("include-text", "assets/bg.svg"), [], []);
    expect(layerFor(p, "assets")?.files).toEqual(["assets/bg.svg"]);
  });

  it("normalizes an embedded path, so `./x` and `x` are one file", () => {
    const claims = [
      ...manifestWithEmbed("include-text", "./assets/bg.svg"),
      ...manifestWithEmbed("include-text", "assets/bg.svg"),
    ];
    const p = partitionLayers(claims, [], []);
    expect(layerFor(p, "assets")?.files).toEqual(["assets/bg.svg"]);
  });

  it("keeps an embedded file out of common even when `files:` also selected it", () => {
    const p = partitionLayers(
      manifestWithEmbed("include-text", "assets/bg.svg"),
      ["assets/bg.svg", "static/other.txt"],
      [],
    );
    expect(layerFor(p, "assets")?.files).toEqual(["assets/bg.svg"]);
    expect(layerFor(p, "common")?.files).toEqual(["static/other.txt"]);
  });

  it("ignores an embed whose path is not usable — the engine reports that", () => {
    expect(partitionLayers(manifestWithEmbed("include-text", "../escape.txt"), [], []).layers)
      .toEqual([]);
  });
});
