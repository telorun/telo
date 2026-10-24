import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PLATFORM_AXES } from "../src/artifact-axes.js";
import { BUILTIN_FRAGMENT_FILES } from "../src/builtin-entries/index.js";
import { readBuiltinVocabulary, type BuiltinVocabulary } from "../src/builtin-vocabulary.js";
import { BUILTIN_VOCABULARY_ARCHIVE } from "../src/builtin-vocabulary/index.js";
import { builtinDefinitions, KERNEL_BUILTINS } from "../src/builtins.js";
import { declarableCapabilities, throwsAllowedCapabilities } from "../src/capability-roster.js";

const ARCHIVE_FILE = new URL("../src/builtin-vocabulary/builtins.yaml", import.meta.url);

function rendered(): BuiltinVocabulary {
  const reading = readBuiltinVocabulary(BUILTIN_VOCABULARY_ARCHIVE);
  expect(reading.problems).toEqual([]);
  return reading.vocabulary!;
}

function documentNamed(vocabulary: BuiltinVocabulary, name: string): Record<string, any> {
  return vocabulary.documents.find((doc) => (doc.metadata as { name: string }).name === name)!;
}

describe("the built-in vocabulary archive", () => {
  it("is the file the renderer wrote, and every reference in it resolves inside it", () => {
    expect(BUILTIN_VOCABULARY_ARCHIVE).toBe(readFileSync(ARCHIVE_FILE, "utf8"));
    // readBuiltinVocabulary refuses an unresolved fragment, value type, zone
    // attribute or Telo format, and a `telo:` key among the fragments.
    rendered();
  });

  it("registers to exactly the registry the analyzer runs on", () => {
    const vocabulary = rendered();
    expect(vocabulary.defs).toEqual(Object.fromEntries(BUILTIN_FRAGMENT_FILES));
    expect(
      builtinDefinitions(vocabulary.documents.map((doc, i) => [`archive document ${i + 2}`, doc] as const)),
    ).toEqual(KERNEL_BUILTINS);
  });

  it("states the declarable capabilities and the throws allowlist in their derived form", () => {
    const vocabulary = rendered();
    for (const name of ["Definition", "Abstract"]) {
      const schema = documentNamed(vocabulary, name).schema;
      expect(schema.properties.capability.enum).toEqual(declarableCapabilities());
    }
    // `throws.codes` is legal on every role; only the dispatchable ones may
    // derive a union from what they dispatch.
    const definition = documentNamed(vocabulary, "Definition").schema;
    expect(definition.if.properties.capability.not.enum).toEqual(throwsAllowedCapabilities());
    expect(definition.then).toEqual({ properties: { throws: { properties: { inherit: false, passthrough: false } } } });
    expect(documentNamed(vocabulary, "Abstract").schema.if).toBeUndefined();
  });

  it("names the platform axes the artifact selectors read", () => {
    expect(Object.keys((rendered().defs.PlatformAxes as { properties: object }).properties)).toEqual([
      ...PLATFORM_AXES,
    ]);
  });
});

describe("readBuiltinVocabulary", () => {
  const ROOT = [
    "kind: Telo.Builtins",
    "metadata:",
    "  name: Telo",
    "  version: 0.119.0",
    "  license: MIT",
  ];

  it.each([
    [
      "a root not named Telo",
      ["kind: Telo.Builtins", "metadata:", "  name: Other", "  version: 1.0.0", "  license: MIT"],
      "the root's `metadata.name` is not `Telo`",
    ],
    [
      "a root with no version",
      ["kind: Telo.Builtins", "metadata:", "  name: Telo", "  license: MIT"],
      "the root declares no `metadata.version`",
    ],
    [
      "a root not licensed MIT",
      ["kind: Telo.Builtins", "metadata:", "  name: Telo", "  version: 1.0.0"],
      "the root does not declare `metadata.license: MIT`",
    ],
    [
      "a hoisted fragment key",
      [...ROOT, "$defs:", "  \"telo:Step\":", "    type: object"],
      "`$defs` holds 'telo:Step'",
    ],
    [
      "a document of another kind",
      [...ROOT, "---", "kind: Telo.Library", "metadata:", "  name: Lib"],
      "is `kind: Telo.Library`",
    ],
    [
      "a document declaring controllers",
      [
        ...ROOT,
        "---",
        "kind: Telo.Definition",
        "metadata:",
        "  name: Thing",
        "controllers:",
        "  - pkg:npm/x@1.0.0",
      ],
      "declares `controllers:`",
    ],
    [
      "a fragment reference the root does not hold",
      [
        ...ROOT,
        "---",
        "kind: Telo.Definition",
        "metadata:",
        "  name: Thing",
        "schema:",
        "  $ref: \"telo://manifest#/$defs/Step\"",
      ],
      "'telo://manifest#/$defs/Step' names no fragment",
    ],
    [
      "a value type the root does not hold",
      [
        ...ROOT,
        "---",
        "kind: Telo.Definition",
        "metadata:",
        "  name: Thing",
        "schema:",
        "  x-telo-type: Telo.Url",
      ],
      "`x-telo-type: Telo.Url` names no entry of `valueTypes`",
    ],
    [
      "a Telo format the root does not hold",
      [
        ...ROOT,
        "---",
        "kind: Telo.Definition",
        "metadata:",
        "  name: Thing",
        "schema:",
        "  format: css-selector",
      ],
      "`format: css-selector` names no entry of `formats`",
    ],
  ])("refuses %s", (_case, lines, problem) => {
    const reading = readBuiltinVocabulary(`${lines.join("\n")}\n`);
    expect(reading.vocabulary).toBeUndefined();
    expect(reading.problems.join("\n")).toContain(problem);
  });
});
