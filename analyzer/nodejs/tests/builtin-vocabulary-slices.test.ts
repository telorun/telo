import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { selectBuiltins, type BuiltinVocabularyEntry } from "../src/builtin-vocabulary-slices.js";
import { BUILTIN_VOCABULARY_ARCHIVE } from "../src/builtin-vocabulary/index.js";

// What the renderer recorded as it emitted the archive: every selectable entry
// and its exact text. `analyzer/rust/src/builtin_vocabulary_slices.rs` is held to
// the same file, so the two CLIs print the same bytes for every name.
const EXPECTED: BuiltinVocabularyEntry[] = JSON.parse(
  readFileSync(new URL("../builtin-vocabulary-slices.json", import.meta.url), "utf8"),
).entries;

describe("selecting entries of the built-in vocabulary", () => {
  it("prints, for every name, exactly the text the renderer emitted for its entry", () => {
    for (const entry of EXPECTED) {
      for (const name of entry.names) {
        expect(selectBuiltins(BUILTIN_VOCABULARY_ARCHIVE, [name]), name).toEqual({
          ok: true,
          text: entry.text,
        });
      }
    }
  });

  it("joins several entries with `---`, in argument order", () => {
    const text = (name: string) => EXPECTED.find((entry) => entry.names.includes(name))!.text;
    expect(selectBuiltins(BUILTIN_VOCABULARY_ARCHIVE, ["Step", "Telo.Application"])).toEqual({
      ok: true,
      text: `${text("Step")}---\n${text("Application")}`,
    });
  });

  it("answers an unknown name with every unknown one and the names there are", () => {
    const selection = selectBuiltins(BUILTIN_VOCABULARY_ARCHIVE, ["Application", "Aplication", "Stp"]);
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.unknown).toEqual(["Aplication", "Stp"]);
    const lines = selection.message.split("\n");
    expect(lines[0]).toBe("No built-in is named 'Aplication', 'Stp'. The names are:");
    expect(lines.slice(1).map((line) => line.split(":")[0])).toEqual([
      "  kinds (with or without 'Telo.')",
      "  fragments",
      "  value types",
      "  zone attributes",
      "  formats",
    ]);
    expect(lines[1]).toContain("Abstract, Application,");
    expect(lines[5]).toBe("  formats: css-selector, language-tag, message-pattern, re2-pattern");
  });
});
