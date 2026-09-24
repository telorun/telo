import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { defaultCustomTags, isTaggedSentinel } from "@telorun/templating";
import { parseLoadedFile } from "../src/parse-loaded-file.js";
import { migrateFileText } from "../src/migrations/driver.js";
import { parseMigrationEntry } from "../src/migrations/entry-data.js";
import { CORE_MIGRATIONS } from "../src/migrations/registry.js";
import { StaticAnalyzer } from "../src/analyzer.js";
import { withSyntheticPositions } from "../src/with-synthetic-positions.js";

const FILE = "/ws/telo.yaml";

const text = [
  "kind: Telo.Application",
  "metadata:",
  "  name: App",
  "targets:",
  "  - name: say",
  "    invoke: !ref say",
  "    inputs:",
  '      lone: "${{ variables.name }}"',
  "      single: '${{ \"a\" + variables.name }}'",
  '      text: "hello ${{ variables.name }}!"',
  "      block: |",
  "        line ${{ variables.name }}",
  '      tagged: !literal "${{ kept }}"',
  '      broken: "${{ never"',
  "      list:",
  '        - "${{ 1 }}"',
  "",
].join("\n");

function migrate(source: string) {
  return migrateFileText({
    source: FILE,
    text: source,
    documents: parseAllDocuments(source, { customTags: defaultCustomTags() }),
    manifests: parseLoadedFile(FILE, FILE, source).manifests,
  });
}

describe("untagged-interpolation", () => {
  it("rewrites a lone hole to !cel and text with holes to !interpolate, keeping the text", () => {
    const migrated = migrate(text)!;
    expect(migrated.unwritable).toEqual([]);
    expect(migrated.text).toContain('lone: !cel "variables.name"');
    expect(migrated.text).toContain("single: !cel \"\\\"a\\\" + variables.name\"");
    expect(migrated.text).toContain('text: !interpolate "hello ${{ variables.name }}!"');
    expect(migrated.text).toContain("block: !interpolate |\n        line ${{ variables.name }}\n");
    expect(migrated.text).toContain('tagged: !literal "${{ kept }}"');
    expect(migrated.text).toContain('broken: "${{ never"');
    expect(migrated.text).toContain('- !cel "1"');
    expect(migrate(migrated.text)).toBeNull();
  });

  it("reads the migrated tree as the tags it writes, and reports the legacy spelling", () => {
    const loaded = parseLoadedFile(FILE, FILE, text, { migrate: true });
    const inputs = (loaded.manifests[0] as any).targets[0].inputs;
    expect(inputs.lone).toMatchObject({ engine: "cel", source: "variables.name" });
    expect(inputs.text).toMatchObject({ engine: "interpolate", source: "hello ${{ variables.name }}!" });
    expect(isTaggedSentinel(inputs.broken)).toBe(false);
    const codes = loaded.migrations.diagnostics.map((d) => d.code);
    expect(codes.filter((c) => c === "DEPRECATED_UNTAGGED_INTERPOLATION")).toHaveLength(5);
    expect(loaded.migrations.diagnostics[0]!.tags).toContain(2);
  });

  it("leaves a string with no readable hole to the refusal both halves share", () => {
    const loaded = parseLoadedFile(FILE, FILE, text, { migrate: true });
    const diagnostics = new StaticAnalyzer().analyze(
      withSyntheticPositions(loaded.manifests.filter((m) => m !== null) as any),
    );
    const untagged = diagnostics.filter((d) => d.code === "UNTAGGED_INTERPOLATION");
    expect(untagged.map((d) => (d.data as { path: string }).path)).toEqual([
      "targets[0].inputs.broken",
    ]);
    expect(() => parseLoadedFile(FILE, FILE, text, { migrate: true, compile: true })).toThrow(
      /ERR_UNTAGGED_INTERPOLATION|never evaluated/,
    );
  });

  it("writes a lone hole's expression so every character reads back as written", () => {
    const text = ["kind: Telo.Application", "metadata:", "  name: App", 'note: "${{ \'a\\rb\\u0001\' }}"', ""].join("\n");
    const migrated = migrate(text)!;
    expect(migrated.unwritable).toEqual([]);
    const reread = parseLoadedFile(FILE, FILE, migrated.text).manifests[0] as any;
    expect(reread.note).toMatchObject({ engine: "cel", source: "'a\rb\u0001'" });
  });

  it("keeps a kind whose description quotes a hole compilable", () => {
    const kind = [
      "kind: Telo.Library",
      "metadata:",
      "  name: Lib",
      "---",
      "kind: Telo.Definition",
      "metadata:",
      "  name: Thing",
      "capability: Telo.Invocable",
      "schema:",
      "  type: object",
      "  properties:",
      "    token:",
      "      type: string",
      '      description: "typically ${{ secrets.token }}"',
      "",
    ].join("\n");
    const loaded = parseLoadedFile(FILE, FILE, kind, { migrate: true });
    const codes = new StaticAnalyzer()
      .analyze(withSyntheticPositions(loaded.manifests.filter((m) => m !== null) as any))
      .map((d) => d.code);
    expect(codes).not.toContain("SCHEMA_COMPILE_ERROR");
  });

  it("is a core entry", () => {
    expect(CORE_MIGRATIONS.map((e) => e.id)).toContain("untagged-interpolation");
  });
});

describe("the scalar match and set-tag source", () => {
  const entry = (match: object, patch: object[]) => ({
    id: "e",
    code: "E",
    severity: "warning",
    reason: "r",
    rules: [{ match, patch }],
  });

  it("refuses a wildcard scalar rule on the module surface", () => {
    expect(() =>
      parseMigrationEntry(
        "m.json",
        entry({ scalar: "lone-hole", inKind: ["*"], under: ["*"] }, [{ op: "set-tag", tag: "cel" }]),
        "module",
      ),
    ).toThrow(/may not reach/);
  });

  it("refuses source: hole without a lone-hole match", () => {
    expect(() =>
      parseMigrationEntry(
        "m.json",
        entry({ scalar: "interpolated", inKind: ["*"], under: ["*"] }, [
          { op: "set-tag", tag: "cel", source: "hole" },
        ]),
      ),
    ).toThrow(/lone-hole/);
  });

  it("refuses a key beside a scalar selector, and a value test on a scalar rule", () => {
    expect(() =>
      parseMigrationEntry("m.json", entry({ key: "a", scalar: "lone-hole", inKind: ["X"], under: ["a"] }, [{ op: "remove-entry" }])),
    ).toThrow(/exactly one of 'key' or 'scalar'/);
    expect(() =>
      parseMigrationEntry("m.json", entry({ scalar: "lone-hole", value: "x", inKind: ["X"], under: ["a"] }, [{ op: "remove-entry" }])),
    ).toThrow(/does not apply to a 'scalar' rule/);
  });
});
