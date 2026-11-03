import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";

/** The Application `translations:` block and the built-in translation kinds at `telo check`. */
function inMemorySource(files: Record<string, string>): ManifestSource {
  return {
    supports() {
      return true;
    },
    async read(url: string) {
      const file = url in files ? url : `${url.replace(/\/$/, "")}/telo.yaml`;
      const text = files[file];
      if (text === undefined) throw new Error(`File not found: ${url}`);
      return { text, source: file };
    },
    resolveRelative(base: string, relative: string): string {
      return new URL(relative, `file://${base}`).pathname;
    },
  };
}

/** `[code, path]` of every error `telo check` reports for `/app/telo.yaml`. */
async function errors(text: string): Promise<Array<[string, string]>> {
  const graph = await new Loader([inMemorySource({ "/app/telo.yaml": text })]).loadGraph("/app/telo.yaml", {
    desugarImports: true,
  });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => [String(d.code), String((d.data as { path?: string }).path)]);
}

describe("the translations block", () => {
  it("takes inline and referenced catalogs, a later one translating a text an earlier one does", async () => {
    expect(
      await errors(`kind: Telo.Application
metadata: { name: App }
lang: en
translations:
  catalogs:
    - kind: Telo.TextTranslations
      lang: pl
      texts:
        - { text: "Save", translation: "Zapisz" }
    - !ref overrides
---
kind: Telo.TextTranslations
metadata: { name: overrides }
lang: pl
texts:
  - { text: "Save", translation: "Zachowaj" }
`),
    ).toEqual([]);
  });

  it("is refused on a library", async () => {
    expect(
      await errors(`kind: Telo.Library
metadata: { name: Lib }
translations:
  catalogs:
    - { kind: Telo.TextTranslations, lang: pl, texts: [] }
`),
    ).toEqual([["SCHEMA_VIOLATION", ""]]);
  });

  it("refuses a catalog of a kind that is no translations", async () => {
    expect(
      await errors(`kind: Telo.Application
metadata: { name: App }
translations:
  catalogs:
    - !ref sink
---
kind: Telo.ConsoleSink
metadata: { name: sink }
`),
    ).toEqual([["REFERENCE_KIND_MISMATCH", "translations.catalogs[0]"]]);
  });

  it("refuses one text translated twice in one catalog", async () => {
    expect(
      await errors(`kind: Telo.Application
metadata: { name: App }
lang: en
translations:
  catalogs:
    - kind: Telo.TextTranslations
      lang: pl
      texts:
        - { text: "Save", translation: "Zapisz" }
        - { text: "Save", translation: "Zachowaj" }
`),
    ).toEqual([["MESSAGE_ENTRY_DUPLICATE", "translations.catalogs[0].texts[1]"]]);
  });
});
