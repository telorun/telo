import { describe, expect, it } from "vitest";
import {
  INCLUDE_BYTES_ENGINE,
  INCLUDE_TEXT_ENGINE,
  makeTaggedSentinel,
} from "@telorun/templating";
import { substituteCelFields, validateAgainstSchema } from "../src/schema-compat.js";
import { collectModuleFileClaims } from "../src/module-file-claims.js";

const library = "kind: Telo.Library\nmetadata:\n  name: demo\n  version: 1.0.0\n";

const withDocs = (...docs: string[]) => [library, ...docs].join("---\n");

const paths = (text: string, role?: string) =>
  collectModuleFileClaims(text)
    .filter((c) => role === undefined || c.role === role)
    .map((c) => c.path)
    .sort();

describe("collectModuleFileClaims", () => {
  it("claims a bundled controller's entry point", () => {
    const claims = collectModuleFileClaims(
      withDocs(
        "kind: Telo.Definition\nmetadata:\n  name: K\ncontrollers:\n  - pkg:telo/local/js?path=./nodejs/c.mjs\n",
      ),
    );
    expect(claims).toEqual([
      expect.objectContaining({
        role: "controller",
        path: "nodejs/c.mjs",
        origin: "pkg:telo/local/js?path=./nodejs/c.mjs",
      }),
    ]);
  });

  it("carries a candidate's sibling patterns, unexpanded", () => {
    const [claim] = collectModuleFileClaims(
      withDocs(
        "kind: Telo.Definition\nmetadata:\n  name: K\ncontrollers:\n  - pkg:telo/local/js?path=./a.mjs&siblings=./pkg/*.wasm\n",
      ),
    );
    // Globs stay patterns here: matching them needs the selected file set, which
    // is the caller's to know.
    expect(claim?.siblings).toEqual(["./pkg/*.wasm"]);
  });

  it("ignores non-bundled candidates and unparseable PURLs", () => {
    expect(
      collectModuleFileClaims(
        withDocs(
          "kind: Telo.Definition\nmetadata:\n  name: K\ncontrollers:\n" +
            "  - pkg:npm/@telorun/x@1.0.0?local_path=./nodejs#c\n" +
            "  - not-a-purl\n",
        ),
      ),
    ).toEqual([]);
  });

  it("claims a file an `!include-*` tag embeds, wherever the tag is written", () => {
    const text = withDocs(
      "kind: Demo.Thing\nmetadata:\n  name: t\n" +
        "font: !include-bytes assets/f.ttf\n" +
        "nested:\n  deep:\n    - svg: !include-text assets/bg.svg\n",
    );
    expect(paths(text, "assets")).toEqual(["assets/bg.svg", "assets/f.ttf"]);
  });

  it("names the tag and the value's path as the claim's origin", () => {
    const [claim] = collectModuleFileClaims(
      withDocs("kind: Demo.Thing\nmetadata:\n  name: t\nfont: !include-bytes assets/f.ttf\n"),
    );
    expect(claim?.origin).toBe("!include-bytes at 'font'");
  });

  it("normalizes a claimed path so one file is claimed once", () => {
    const text = withDocs(
      "kind: Demo.Thing\nmetadata:\n  name: a\nx: !include-text ./assets/bg.svg\n",
      "kind: Demo.Thing\nmetadata:\n  name: b\ny: !include-text assets/./bg.svg\n",
    );
    expect(paths(text)).toEqual(["assets/bg.svg"]);
  });

  it("claims nothing for a path the engine rejects", () => {
    const text = withDocs("kind: Demo.Thing\nmetadata:\n  name: t\nx: !include-text ../out.txt\n");
    expect(collectModuleFileClaims(text)).toEqual([]);
  });

  it("claims nothing from tags that embed no files", () => {
    const text = withDocs(
      "kind: Demo.Thing\nmetadata:\n  name: t\n" +
        'a: !cel "1 + 1"\nb: !ref Other\nc: !literal hello\n',
    );
    expect(collectModuleFileClaims(text)).toEqual([]);
  });

  it("collects controller and embed claims from the same manifest", () => {
    const text = withDocs(
      "kind: Telo.Definition\nmetadata:\n  name: K\ncontrollers:\n  - pkg:telo/local/js?path=./nodejs/c.mjs\n",
      "kind: Demo.Thing\nmetadata:\n  name: t\nfont: !include-bytes assets/f.ttf\n",
    );
    expect(paths(text, "controller")).toEqual(["nodejs/c.mjs"]);
    expect(paths(text, "assets")).toEqual(["assets/f.ttf"]);
  });

  it("gives the same answer before and after `include:` partials are inlined", () => {
    // Publish inlines each partial as an extra document into one telo.yaml.
    // Claims are root-relative, so that rewrite cannot move a file.
    const asPartials = withDocs("kind: Demo.Thing\nmetadata:\n  name: t\nx: !include-text a/b.txt\n");
    const asOneDoc =
      library + "---\nkind: Demo.Thing\nmetadata:\n  name: t\nx: !include-text a/b.txt\n";
    expect(paths(asPartials)).toEqual(paths(asOneDoc));
  });
});

describe("substituteCelFields — embed types", () => {
  it("types an embed by its TAG, not by the slot it sits in", () => {
    // A CEL expression's type is only derivable from the expression, so it gets
    // a slot-shaped placeholder. An embed's type is a constant of the tag, and
    // giving it the slot's shape made every slot accept both tags — so a byte
    // embed at a `type: string` field passed check and failed at creation.
    const schema = {
      type: "object",
      properties: { code: { type: "string" }, blob: { "x-telo-type": "Telo.Bytes" } },
    } as Record<string, any>;
    const data = {
      code: makeTaggedSentinel(INCLUDE_BYTES_ENGINE, "assets/x.bin"),
      blob: makeTaggedSentinel(INCLUDE_TEXT_ENGINE, "assets/x.txt"),
    };
    const substituted = substituteCelFields(data, schema, schema) as Record<string, unknown>;
    expect(substituted.code).toBeInstanceOf(Uint8Array);
    expect(substituted.blob).toBe("");
    expect(validateAgainstSchema(substituted, schema)).toHaveLength(2);
  });

  it("accepts each embed at the slot whose type it produces", () => {
    const schema = {
      type: "object",
      properties: { code: { type: "string" }, blob: { "x-telo-type": "Telo.Bytes" } },
    } as Record<string, any>;
    const data = {
      code: makeTaggedSentinel(INCLUDE_TEXT_ENGINE, "assets/x.txt"),
      blob: makeTaggedSentinel(INCLUDE_BYTES_ENGINE, "assets/x.bin"),
    };
    const substituted = substituteCelFields(data, schema, schema);
    expect(validateAgainstSchema(substituted, schema)).toEqual([]);
  });

  it("still gives a CEL expression the slot's placeholder", () => {
    const schema = { type: "object", properties: { code: { type: "string" } } } as Record<string, any>;
    const data = { code: makeTaggedSentinel("cel", "variables.x") };
    const substituted = substituteCelFields(data, schema, schema);
    expect(validateAgainstSchema(substituted, schema)).toEqual([]);
  });
});
