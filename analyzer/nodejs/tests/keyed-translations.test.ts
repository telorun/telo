import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";

/** `Telo.KeyedTranslations`, the kind it declares, and `x-telo-text-keys` at `telo check`. */
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
async function errors(files: Record<string, string>): Promise<Array<[string, string]>> {
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => d.severity === DiagnosticSeverity.Error)
    .map((d) => [String(d.code), String((d.data as { path?: string }).path)]);
}

const DECLARATION = `kind: Telo.KeyedTranslations
metadata: { name: Translations }
keys:
  save: Save
  lang: Language
  kind: Kind
  pagerRange:
    message: "{$first}–{$last} of {$total}"
    values: { first: { type: integer }, last: { type: integer }, total: { type: integer } }
  minLength:
    message: { plural: limit, cases: { one: "Must be at least {$limit} character", other: "Must be at least {$limit} characters" } }
    values: { limit: { type: integer } }
    description: Shown under a field whose value is too short.
`;

const LIBRARY = `kind: Telo.Library
metadata: { name: Lib }
lang: en
exports: { kinds: [Translations] }
---
${DECLARATION}`;

/** An application importing the library and listing `catalog`, a resource of its keyed kind. */
function application(catalog: string): Record<string, string> {
  return {
    "/lib/telo.yaml": LIBRARY,
    "/app/telo.yaml": `kind: Telo.Application
metadata: { name: App }
lang: en
imports:
  Lib: ../lib
translations:
  catalogs:
    - !ref catalog
---
kind: Lib.Translations
metadata: { name: catalog }
${catalog}`,
  };
}

describe("a keyed declaration", () => {
  it("checks clean, keys named lang and kind included, with a catalog translating some keys", async () => {
    expect(
      await errors(
        application(`lang: pl
messages:
  save: Zapisz
  lang: Język
  kind: Rodzaj
  pagerRange: "{$first}–{$last} z {$total}"
  minLength: { plural: limit, cases: { one: "Co najmniej {$limit} znak", few: "Co najmniej {$limit} znaki", other: "Co najmniej {$limit} znaków" } }
`),
      ),
    ).toEqual([]);
  });

  it("is refused in a module that declares no lang:", async () => {
    expect(
      await errors({
        "/app/telo.yaml": `kind: Telo.Library
metadata: { name: Lib }
---
kind: Telo.KeyedTranslations
metadata: { name: Translations }
keys:
  save: Save
`,
      }),
    ).toEqual([["MESSAGE_SOURCE_LANGUAGE_MISSING", "keys"]]);
  });

  it("refuses a source message reading a value its key does not declare", async () => {
    expect(
      await errors({
        "/app/telo.yaml": `kind: Telo.Library
metadata: { name: Lib }
lang: en
---
kind: Telo.KeyedTranslations
metadata: { name: Translations }
keys:
  save: "Save {$what}"
  range: { message: "{$first} of {$total}", values: { first: { type: integer } } }
`,
      }),
    ).toEqual([
      ["MESSAGE_PLACEHOLDER_UNBOUND", "keys.save"],
      ["MESSAGE_PLACEHOLDER_UNBOUND", "keys.range.message"],
    ]);
  });

  it("refuses a source plural case its module's language does not have", async () => {
    expect(
      await errors({
        "/app/telo.yaml": `kind: Telo.Library
metadata: { name: Lib }
lang: en
---
kind: Telo.KeyedTranslations
metadata: { name: Translations }
keys:
  items: { message: { plural: n, cases: { few: "{$n} items", other: "{$n} items" } }, values: { n: { type: integer } } }
`,
      }),
    ).toEqual([["MESSAGE_PLURAL_CATEGORY_INVALID", "keys.items.message.cases.few"]]);
  });

  it("refuses a declared value no message can format, and a value written as a bare type name", async () => {
    expect(
      await errors({
        "/app/telo.yaml": `kind: Telo.Library
metadata: { name: Lib }
lang: en
---
kind: Telo.KeyedTranslations
metadata: { name: Translations }
keys:
  flag: { message: "On", values: { on: { type: boolean } } }
  range: { message: "{$first}", values: { first: integer } }
`,
      }),
    ).toEqual([
      ["SCHEMA_VIOLATION", "keys.range.values.first"],
      ["TEXT_VALUES_INVALID", "keys.flag.values.on"],
    ]);
  });
});

describe("a catalog of a keyed kind", () => {
  it("refuses a key its declaration does not declare", async () => {
    expect(await errors(application(`lang: pl\nmessages: { sav: Zapisz }\n`))).toEqual([
      ["SCHEMA_VIOLATION", "messages"],
    ]);
  });

  it("refuses a placeholder outside its key's declared values", async () => {
    expect(await errors(application(`lang: pl\nmessages: { pagerRange: "{$first} z {$count}" }\n`))).toEqual([
      ["MESSAGE_PLACEHOLDER_UNBOUND", "messages.pagerRange"],
    ]);
  });

  it("refuses a plural case the catalog's own language does not have", async () => {
    expect(
      await errors(
        application(`lang: en
messages:
  minLength: { plural: limit, cases: { one: "At least {$limit} char", few: "At least {$limit} chars", other: "At least {$limit} chars" } }
`),
      ),
    ).toEqual([["MESSAGE_PLURAL_CATEGORY_INVALID", "messages.minLength.cases.few"]]);
  });

  it("refuses a computed message", async () => {
    expect(await errors(application(`lang: pl\nmessages: { save: !cel "'Zapisz'" }\n`))).toEqual([
      ["MESSAGE_ENTRY_COMPUTED", "messages.save"],
    ]);
  });
});

describe("x-telo-text-keys", () => {
  const kind = (schema: string): Record<string, string> => ({
    "/app/telo.yaml": `kind: Telo.Library
metadata: { name: Lib }
lang: en
---
${DECLARATION}---
kind: Telo.Definition
metadata: { name: Pager }
capability: Telo.Service
controllers: ["pkg:telo/local/js?path=./pager.mjs#Pager"]
schema:
${schema}`,
  });

  it("names the keyed sets on a kind's schema root", async () => {
    expect(await errors(kind(`  x-telo-text-keys: [Self.Translations]\n  type: object\n`))).toEqual([]);
  });

  it("is refused below the schema's root", async () => {
    expect(
      await errors(
        kind(`  type: object\n  properties:\n    label: { type: string, x-telo-text-keys: [Self.Translations] }\n`),
      ),
    ).toEqual([["TEXT_KEYS_INVALID", "schema.properties.label.x-telo-text-keys"]]);
  });

  it("is refused naming a kind that translates by text", async () => {
    expect(await errors(kind(`  x-telo-text-keys: [Telo.TextTranslations]\n  type: object\n`))).toEqual([
      ["TEXT_KEYS_INVALID", "schema.x-telo-text-keys[0]"],
    ]);
  });
});
