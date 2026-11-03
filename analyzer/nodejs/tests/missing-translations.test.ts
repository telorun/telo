import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { DiagnosticSeverity, type ManifestSource } from "../src/types.js";

/** `MESSAGE_TRANSLATION_MISSING`: what a served language shows untranslated. */
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

/** `[path, message]` of every `MESSAGE_TRANSLATION_MISSING` for `/app/telo.yaml`, each a warning. */
async function missing(application: string): Promise<Array<[string, string]>> {
  const files = { "/lib/telo.yaml": LIBRARY, "/app/telo.yaml": application };
  const graph = await new Loader([inMemorySource(files)]).loadGraph("/app/telo.yaml", { desugarImports: true });
  const diagnostics = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
    moduleDocuments: collectModuleDocuments(graph),
  });
  expect(diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error)).toEqual([]);
  return diagnostics
    .filter((d) => d.code === "MESSAGE_TRANSLATION_MISSING")
    .map((d) => {
      expect(d.severity).toBe(DiagnosticSeverity.Warning);
      return [String((d.data as { path?: string }).path), d.message];
    });
}

/** A library in English: a keyed set, a kind showing it, a kind with a `Text`
 *  field, a Polish catalog of the set it exports, and a text of its own. */
const LIBRARY = `kind: Telo.Library
metadata: { name: Lib }
lang: en
exports: { kinds: [Translations, Pager, Label, Translate, Show], resources: [polish] }
---
kind: Telo.KeyedTranslations
metadata: { name: Translations }
keys: { save: Save, cancel: Cancel, close: Close }
---
kind: Self.Translations
metadata: { name: polish }
lang: pl
messages: { save: Zapisz, cancel: Anuluj, close: Zamknij }
---
kind: Telo.Definition
metadata: { name: Pager }
capability: Telo.Invocable
controllers: [pkg:npm/none@0.0.0]
schema: { type: object, x-telo-text-keys: [Self.Translations] }
throws:
  codes:
    ERR_PAGE_GONE: { description: The page was removed., displayMessage: "The page is gone." }
---
kind: Telo.Definition
metadata: { name: Translate }
capability: Telo.Callable
deterministic: true
controllers: [pkg:npm/none@0.0.0]
params: [{ name: text, schema: { $ref: "telo://manifest#/$defs/Text" } }]
returns: { schema: { type: string } }
---
kind: Telo.Definition
metadata: { name: Show }
capability: Telo.Provider
controllers: [pkg:npm/none@0.0.0]
schema: { type: object, properties: { message: { type: string } } }
---
kind: Telo.Definition
metadata: { name: Label }
capability: Telo.Provider
controllers: [pkg:npm/none@0.0.0]
schema:
  type: object
  properties: { text: { $ref: "telo://manifest#/$defs/Text" } }
---
kind: Self.Label
metadata: { name: libraryLabel }
text: Library label
`;

/** An application in English showing the keyed set and two texts, `head` above its documents. */
const application = (head: string) => `kind: Telo.Application
metadata: { name: App }
imports: { Lib: ../lib }
${head}
---
kind: Lib.Pager
metadata: { name: pager }
---
kind: Lib.Label
metadata: { name: greeting }
text: Hello
---
kind: Lib.Label
metadata: { name: farewell }
text: { text: Bye, context: leaving }
`;

const POLISH_TEXTS = `kind: Telo.TextTranslations
      lang: pl
      texts:
        - { text: Hello, translation: Cześć }
        - { text: Bye, context: leaving, translation: Pa }
        - { text: Library label, translation: Etykieta biblioteki }
        - { text: The page is gone., translation: Strony już nie ma. }`;

describe("a served language missing translations", () => {
  it("is warned once, naming the text no catalog translates", async () => {
    expect(
      await missing(
        application(`lang: en
translations:
  catalogs:
    - !ref Lib.polish
    - kind: Telo.TextTranslations
      lang: pl
      texts:
        - { text: Hello, translation: Cześć }
        - { text: Library label, translation: Etykieta biblioteki }
        - { text: The page is gone., translation: Strony już nie ma. }`),
      ),
    ).toEqual([
      [
        "translations",
        `Telo.Application/App: 'pl' is served, but nothing translates this text into it, so each shows in the language it is written in: "Bye" (context "leaving"). Translate them in a Telo.TextTranslations catalog of lang 'pl' listed under translations.catalogs.`,
      ],
    ]);
  });

  it("counts a kind's declared display messages and a literal text argument", async () => {
    expect(
      await missing(`kind: Telo.Application
metadata: { name: App }
lang: en
imports: { Lib: ../lib }
translations:
  catalogs:
    - !ref Lib.polish
    - { kind: Telo.TextTranslations, lang: pl, texts: [] }
---
kind: Lib.Pager
metadata: { name: pager }
---
kind: Lib.Translate
metadata: { name: t }
---
kind: Lib.Show
metadata: { name: show }
message: !cel "Self.t('Open')"
`),
    ).toEqual([
      [
        "translations",
        `Telo.Application/App: 'pl' is served, but nothing translates these 3 texts into it, so each shows in the language it is written in: "Open", "Library label", "The page is gone.". Translate them in a Telo.TextTranslations catalog of lang 'pl' listed under translations.catalogs.`,
      ],
    ]);
  });

  it("does not count a kind's declared display messages when no declaration instantiates it", async () => {
    expect(
      await missing(`kind: Telo.Application
metadata: { name: App }
lang: en
imports: { Lib: ../lib }
translations:
  catalogs:
    - !ref Lib.polish
    - { kind: Telo.TextTranslations, lang: pl, texts: [{ text: Library label, translation: Etykieta }] }
`),
    ).toEqual([]);
  });

  it("names the keyed set and every key it lacks when no catalog of it is listed", async () => {
    expect(
      await missing(
        application(`lang: en
translations:
  catalogs:
    - ${POLISH_TEXTS}`),
      ),
    ).toEqual([
      [
        "translations",
        `Telo.Application/App: 'pl' is served, but nothing translates these 3 keys of 'Lib.Translations' into it, so each shows its source wording: save, cancel, close. List a catalog of 'Lib.Translations' in lang 'pl' under translations.catalogs that translates them.`,
      ],
    ]);
  });

  it("warns once per missing entry when a regional tag and its shorter variant are both served", async () => {
    const found = await missing(
      application(`lang: en
translations:
  catalogs:
    - ${POLISH_TEXTS}
    - { kind: Telo.TextTranslations, lang: pl-PL, texts: [] }`),
    );
    expect(found.map(([, message]) => message.match(/^Telo\.Application\/App: '([^']+)'.*'(Lib\.Translations)'/)?.slice(1))).toEqual([
      ["pl", "Lib.Translations"],
    ]);
  });

  it("is reported at lang: when no translations block lists a catalog", async () => {
    expect((await missing(application("lang: pl"))).map(([path]) => path)).toEqual(["lang", "lang"]);
  });

  it("holds the built-in error texts to every served language, the built-in translations covering theirs", async () => {
    const serving = (lang: string) => `kind: Telo.Application
metadata: { name: App }
lang: en
translations:
  catalogs:
    - { kind: Telo.TextTranslations, lang: ${lang}, texts: [] }
`;
    expect(await missing(serving("pl-PL"))).toEqual([]);
    expect(await missing(serving("sv"))).toEqual([
      [
        "translations",
        `Telo.Application/App: 'sv' is served, but nothing translates these 5 texts into it, so each shows in the language it is written in: "The service is misconfigured.", "The service failed to compute a value.", "The request is not valid.", "The service produced a result it could not deliver.", "The service failed to decide how to continue.". Translate them in a Telo.TextTranslations catalog of lang 'sv' listed under translations.catalogs.`,
      ],
    ]);
  });

  it("is not reported for an application serving only the language its texts are written in", async () => {
    expect(await missing(application("lang: en-GB"))).toEqual([]);
    expect(await missing(application(""))).toEqual([]);
  });

  it("is not reported for ui's completeness application, which lists every translation ui ships", async () => {
    const fileSource: ManifestSource = {
      supports: (url) => isAbsolute(url),
      async read(url) {
        const file = existsSync(url) && statSync(url).isDirectory() ? join(url, "telo.yaml") : url;
        return { text: readFileSync(file, "utf8"), source: file };
      },
      resolveRelative: (base, relative) => resolve(dirname(base), relative),
    };
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../../../modules/ui/tests/translations.yaml");
    const graph = await new Loader([fileSource]).loadGraph(entry, { desugarImports: true });
    const diagnostics = new StaticAnalyzer().analyze(flattenForAnalyzer(graph), {
      moduleDocuments: collectModuleDocuments(graph),
    });
    expect(diagnostics.filter((d) => d.code === "MESSAGE_TRANSLATION_MISSING").map((d) => d.message)).toEqual([]);
  });
});
