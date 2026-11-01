import { describe, expect, it } from "vitest";
import { StaticAnalyzer } from "../src/analyzer.js";
import { collectModuleDocuments, flattenForAnalyzer } from "../src/flatten-for-analyzer.js";
import { Loader } from "../src/manifest-loader.js";
import { expandManifestFragments } from "../src/manifest-schemas.js";
import { renderValuePath, textSites } from "../src/text-slot.js";
import type { ManifestSource } from "../src/types.js";

/**
 * The built-in text vocabulary at `telo check`: each refusal at the line that wrote
 * it, judged as the writing module writes. The kernel's twins are pinned both ways
 * in `tests/check-run-agreement.yaml`.
 */
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

const TEXT_CODES = /^(MESSAGE_|TEXT_|SCHEMA_VIOLATION$)/;

/** `[code, path]` of every text diagnostic `telo check` reports for the entry. */
async function check(
  files: Record<string, string>,
  entry = "/app/telo.yaml",
  codes: RegExp = TEXT_CODES,
): Promise<Array<[string, string]>> {
  const graph = await new Loader([inMemorySource(files)]).loadGraph(entry, { desugarImports: true });
  return new StaticAnalyzer()
    .analyze(flattenForAnalyzer(graph), { moduleDocuments: collectModuleDocuments(graph) })
    .filter((d) => codes.test(String(d.code)))
    .map((d) => (process.env.DBG ? (console.log(d.code, d.message), d) : d))
    .map((d) => [String(d.code), String((d.data as { path?: string }).path)]);
}

/** A library declaring a kind with a `Text` field, its values, and a catalog kind. */
const LABELS = `kind: Telo.Library
metadata:
  name: Labels
  version: 0.1.0
exports:
  kinds: [Label, Catalog, Line]
---
kind: Telo.Definition
metadata:
  name: Label
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    text: { $ref: "telo://manifest#/$defs/Text" }
    values:
      type: object
      x-telo-text-values-for: /text
---
kind: Telo.Definition
metadata:
  name: Catalog
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    catalog: { $ref: "telo://manifest#/$defs/TextCatalog" }
---
kind: Telo.Definition
metadata:
  name: Line
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    text: { $ref: "telo://manifest#/$defs/Text" }
    values:
      type: object
      x-telo-text-values-for: /text
      x-telo-context:
        type: object
        properties:
          row:
            type: object
            properties:
              name: { type: string }
              done: { type: boolean }
      additionalProperties:
        x-telo-eval: accessor
`;

const app = (lang: string | undefined, body: string) => ({
  "/labels/telo.yaml": LABELS,
  "/app/telo.yaml": [
    `kind: Telo.Application`,
    `metadata:`,
    `  name: App`,
    ...(lang ? [`lang: ${lang}`] : []),
    `imports:`,
    `  Labels: ../labels`,
    `---`,
    body,
  ].join("\n"),
});

describe("a Text field", () => {
  it("accepts a pattern, a plural source and a text with context written in the module's language", async () => {
    expect(
      await check(
        app(
          "en",
          `kind: Labels.Label
metadata: { name: files }
text:
  plural: count
  cases: { "=0": "No files", one: "{$count} file", other: "{$count} files" }
values: { count: 3 }
---
kind: Labels.Label
metadata: { name: open }
text: { text: Open, context: verb }`,
        ),
      ),
    ).toEqual([]);
  });

  it("refuses a pattern that does not parse, a category its language lacks, and a plural source with no lang", async () => {
    expect(
      await check(
        app(
          "en",
          `kind: Labels.Label
metadata: { name: broken }
text: "Hello {name}"
---
kind: Labels.Label
metadata: { name: few }
text: { plural: n, cases: { few: "{$n}", other: "{$n}" } }`,
        ),
      ),
    ).toEqual([
      ["MESSAGE_SYNTAX_INVALID", "text"],
      ["MESSAGE_PLURAL_CATEGORY_INVALID", "text.cases.few"],
    ]);
    expect(
      await check(
        app(undefined, `kind: Labels.Label
metadata: { name: files }
text: { plural: n, cases: { one: "{$n} file", other: "{$n} files" } }`),
      ),
    ).toEqual([["MESSAGE_SOURCE_LANGUAGE_MISSING", "text"]]);
  });

  it("states the selection's shape, an empty context included, as one schema violation", async () => {
    expect(
      await check(
        app("en", `kind: Labels.Label
metadata: { name: empty }
text: { text: Open, context: "" }`),
      ),
    ).toEqual([["SCHEMA_VIOLATION", "text.context"]]);
  });

  it("refuses values that lack a name the text reads, or hold what a message cannot", async () => {
    expect(
      await check(
        app(
          "en",
          `kind: Labels.Label
metadata: { name: files }
text: { plural: count, cases: { one: "{$count} file by {$user}", other: "{$count} files" } }
values: { count: "three" }`,
        ),
      ),
    ).toEqual([
      ["MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED", "values.count"],
      ["MESSAGE_PLACEHOLDER_UNBOUND", "values"],
    ]);
  });

  it("judges a value named by accessor as the type its chain is checked to", async () => {
    expect(
      await check(
        app(
          "en",
          `kind: Labels.Line
metadata: { name: task }
text: "{$name} is {$state}"
values: { name: !cel "row.name", state: !cel "row.done" }`,
        ),
      ),
    ).toEqual([["MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED", "values.state"]]);
  });
});

describe("a text catalog", () => {
  it("refuses a computed entry, an unknown placeholder, a category its language lacks and a duplicate", async () => {
    expect(
      await check(
        app(
          "en",
          `kind: Labels.Catalog
metadata: { name: pl }
catalog:
  lang: pl
  texts:
    - { text: "Open", translation: !cel "'Otwórz'" }
---
kind: Labels.Catalog
metadata: { name: de }
catalog:
  lang: de
  texts:
    - { text: "Open", context: verb, translation: "Öffnen {$who}" }
    - { text: "Open", context: verb, translation: "Öffnen" }
    - { text: "{$n} files", translation: { plural: n, cases: { few: "{$n}", other: "{$n} Dateien" } } }`,
        ),
        "/app/telo.yaml",
        /^(MESSAGE_(?!TEXT_UNUSED)|TEXT_|SCHEMA_VIOLATION$)/,
      ),
    ).toEqual([
      ["MESSAGE_ENTRY_COMPUTED", "catalog.texts[0].translation"],
      ["MESSAGE_PLACEHOLDER_UNKNOWN", "catalog.texts[0].translation"],
      ["MESSAGE_ENTRY_DUPLICATE", "catalog.texts[1]"],
      ["MESSAGE_PLURAL_CATEGORY_INVALID", "catalog.texts[2].translation.cases.few"],
    ]);
  });

  it("warns at an entry whose source no module of its closure shows", async () => {
    const files = app(
      "en",
      `kind: Labels.Label
metadata: { name: open }
text: { text: Open, context: verb }
---
kind: Telo.JsonSchema
metadata: { name: Invoice }
schema:
  type: object
  properties:
    status:
      title: Status
      enum: [paid, due]
      x-telo-text-context: invoice
---
kind: Labels.Catalog
metadata: { name: pl }
catalog:
  lang: pl
  texts:
    - { text: Open, context: verb, translation: Otwórz }
    - { text: paid, context: invoice, translation: zapłacona }
    - { text: Status, context: invoice, translation: Stan }
    - { text: Closed, translation: Zamknięte }`,
    );
    expect(await check(files)).toEqual([["MESSAGE_TEXT_UNUSED", "catalog.texts[3].text"]]);
  });

  it("counts the built-in error texts as shown by every module", async () => {
    const files = app(
      "en",
      `kind: Labels.Catalog
metadata: { name: pl }
catalog:
  lang: pl
  texts:
    - { text: "The request is not valid.", translation: "Żądanie jest nieprawidłowe." }`,
    );
    expect(await check(files)).toEqual([]);
  });
});

describe("the text annotations", () => {
  it("refuses a values pairing naming nothing, or naming no Text, at the kind", async () => {
    expect(
      await check(
        {
          "/lib/telo.yaml": `kind: Telo.Library
metadata:
  name: Lib
---
kind: Telo.Definition
metadata:
  name: Bad
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    title: { type: string }
    a: { type: object, x-telo-text-values-for: /missing }
    b: { type: object, x-telo-text-values-for: /title }
    c: { type: string, x-telo-text-values-for: /title }
    d: { type: object, x-telo-text-values-for: title }`,
        },
        "/lib/telo.yaml",
      ),
    ).toEqual([
      ["TEXT_VALUES_FOR_INVALID", "schema.properties.a.x-telo-text-values-for"],
      ["TEXT_VALUES_FOR_INVALID", "schema.properties.b.x-telo-text-values-for"],
      ["TEXT_VALUES_FOR_INVALID", "schema.properties.c.x-telo-text-values-for"],
      ["SCHEMA_VIOLATION", "schema.properties.d.x-telo-text-values-for"],
    ]);
  });

  it("refuses an empty context on a data schema and warns at one no data schema holds", async () => {
    const diagnostics = await check(
      {
        "/lib/telo.yaml": `kind: Telo.Library
metadata:
  name: Lib
---
kind: Telo.JsonSchema
metadata: { name: Row }
schema:
  type: object
  x-telo-text-context: ""
---
kind: Telo.Definition
metadata:
  name: Kind
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  x-telo-text-context: menu`,
      },
      "/lib/telo.yaml",
    );
    expect(diagnostics).toEqual([
      ["SCHEMA_VIOLATION", "schema.x-telo-text-context"],
      ["TEXT_CONTEXT_MISPLACED", "schema.x-telo-text-context"],
    ]);
  });
});

/** A library with a callable taking a `Text` and its values, and a provider whose
 *  field an expression fills. */
const TR = `kind: Telo.Library
metadata:
  name: Tr
exports:
  kinds: [Translate, Show]
---
kind: Telo.Definition
metadata:
  name: Translate
capability: Telo.Callable
deterministic: true
controllers:
  - pkg:npm/none@0.0.0
params:
  - name: text
    schema: { $ref: "telo://manifest#/$defs/Text" }
  - name: values
    optional: true
    schema: { type: object, x-telo-text-values-for: /text }
returns:
  schema: { type: string }
---
kind: Telo.Definition
metadata:
  name: Show
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    message: { type: string }
`;

const caller = (lang: string | undefined, calls: string[]) => ({
  "/tr/telo.yaml": TR,
  "/app/telo.yaml": [
    `kind: Telo.Application`,
    `metadata:`,
    `  name: App`,
    ...(lang ? [`lang: ${lang}`] : []),
    `imports:`,
    `  Tr: ../tr`,
    `---`,
    `kind: Tr.Translate`,
    `metadata: { name: t }`,
    ...calls.flatMap((call, index) => [
      `---`,
      `kind: Tr.Show`,
      `metadata: { name: show${index} }`,
      `message: !cel ${JSON.stringify(call)}`,
    ]),
  ].join("\n"),
});

describe("a call at a Text parameter", () => {
  it("judges the literal text as the calling module wrote it, and the values written beside it", async () => {
    expect(
      await check(
        caller("en", [
          "Self.t('Hello')",
          "Self.t('{$n} files', {'n': 2})",
          "Self.t({'text': 'Open', 'context': 'verb'})",
          "Self.t('a' + 'b')",
          "Self.t('Hello {name}')",
          "Self.t('Hi {$who}')",
          "Self.t('{$n} files', {'n': true})",
          "Self.t({'plural': 'n', 'cases': {'few': '{$n}', 'other': '{$n}'}}, {'n': 1})",
        ]),
      ),
    ).toEqual([
      ["TEXT_ARGUMENT_COMPUTED", "message"],
      ["MESSAGE_SYNTAX_INVALID", "message"],
      ["MESSAGE_PLACEHOLDER_UNBOUND", "message"],
      ["MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED", "message"],
      ["MESSAGE_PLURAL_CATEGORY_INVALID", "message"],
    ]);
  });

  it("refuses a plural literal in a module with no lang", async () => {
    expect(
      await check(caller(undefined, ["Self.t({'plural': 'n', 'cases': {'one': 'a', 'other': 'b'}}, {'n': 1})"])),
    ).toEqual([["MESSAGE_SOURCE_LANGUAGE_MISSING", "message"]]);
  });

  it("counts a literal text argument among the texts a catalog of the module may translate", async () => {
    const files = caller("en", ["Self.t('Rate not found for {$user}', {'user': 'Ala'})"]);
    files["/app/telo.yaml"] += `
---
kind: Tr.Show
metadata: { name: unrelated }
message: x`;
    files["/tr/telo.yaml"] += `---
kind: Telo.Definition
metadata:
  name: Catalog
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    catalog: { $ref: "telo://manifest#/$defs/TextCatalog" }
`;
    files["/tr/telo.yaml"] = files["/tr/telo.yaml"].replace("kinds: [Translate, Show]", "kinds: [Translate, Show, Catalog]");
    files["/app/telo.yaml"] += `
---
kind: Tr.Catalog
metadata: { name: pl }
catalog:
  lang: pl
  texts:
    - { text: "Rate not found for {$user}", translation: "Nie znaleziono stawki dla {$user}" }
    - { text: "Rate not found", translation: "Nie znaleziono stawki" }`;
    expect(await check(files, "/app/telo.yaml", /^MESSAGE_TEXT_UNUSED$/)).toEqual([
      ["MESSAGE_TEXT_UNUSED", "catalog.texts[1].text"],
    ]);
  });

  it("refuses a values pairing that names no Text parameter", async () => {
    expect(
      await check(
        {
          "/tr/telo.yaml": TR.replace("x-telo-text-values-for: /text", "x-telo-text-values-for: /nope"),
        },
        "/tr/telo.yaml",
      ),
    ).toEqual([["TEXT_VALUES_FOR_INVALID", "params[1].schema.x-telo-text-values-for"]]);
  });
});

describe("a text another module writes into", () => {
  /** A library writing in Polish, with a template body and a base: mapping
   *  forwarding into a `Text`. */
  const LIB = `kind: Telo.Library
metadata:
  name: Lib
lang: pl
exports:
  kinds: [Label, Caption, Banner]
---
kind: Telo.Definition
metadata:
  name: Label
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    text: { $ref: "telo://manifest#/$defs/Text" }
---
kind: Telo.Definition
metadata:
  name: Caption
extends: Self.Label
schema:
  type: object
  properties:
    caption: {}
base:
  text: !cel "self.caption"
---
kind: Telo.Definition
metadata:
  name: Banner
capability: Telo.Runnable
schema:
  type: object
  properties:
    title: {}
resources:
  - kind: Self.Label
    metadata: { name: fixed }
    text: { plural: n, cases: { few: "{$n} pliki", many: "{$n} plików", other: "{$n} pliku" } }
  - kind: Self.Label
    metadata: { name: forwarded }
    text: !cel "self.title"
`;

  it("judges a template body's literal and a base: literal by the defining module's language", async () => {
    expect(await check({ "/lib/telo.yaml": LIB }, "/lib/telo.yaml")).toEqual([]);
    expect(
      await check({ "/lib/telo.yaml": LIB.replace("lang: pl\n", "lang: en\n") }, "/lib/telo.yaml"),
    ).toEqual([
      ["MESSAGE_PLURAL_CATEGORY_INVALID", "resources[0].text.cases.few"],
      ["MESSAGE_PLURAL_CATEGORY_INVALID", "resources[0].text.cases.many"],
    ]);
  });

  it("judges a template body's literal by the defining module's language in each consumer's view of it", async () => {
    expect(
      await check({
        "/lib/telo.yaml": LIB,
        "/app/telo.yaml": `kind: Telo.Application
metadata:
  name: App
lang: en
imports:
  Lib: ../lib
---
kind: Lib.Banner
metadata: { name: banner }
title: { plural: n, cases: { few: "{$n} files", other: "{$n} files" } }`,
      }),
    ).toEqual([["MESSAGE_PLURAL_CATEGORY_INVALID", "title.cases.few"]]);
  });

  it("leaves a template body's own literal to the definition's check, never a consumer's", async () => {
    expect(
      await check({
        "/lib/telo.yaml": LIB.replace("lang: pl\n", "lang: en\n"),
        "/app/telo.yaml": `kind: Telo.Application
metadata:
  name: App
lang: en
imports:
  Lib: ../lib
---
kind: Lib.Banner
metadata: { name: banner }
title: Files`,
      }),
    ).toEqual([]);
  });

  it("judges a value a base: mapping forwards as its consumer wrote it", async () => {
    expect(
      await check({
        "/lib/telo.yaml": LIB,
        "/app/telo.yaml": `kind: Telo.Application
metadata:
  name: App
imports:
  Lib: ../lib
---
kind: Lib.Caption
metadata: { name: files }
caption: { plural: n, cases: { one: "{$n} file", other: "{$n} files" } }`,
      }),
    ).toEqual([["MESSAGE_SOURCE_LANGUAGE_MISSING", "caption"]]);
  });
});

describe("a TextRecord field", () => {
  it("holds a record the text walk never enters", async () => {
    expect(
      await check({
        "/app/telo.yaml": `kind: Telo.Application
metadata:
  name: App
---
kind: Telo.Definition
metadata:
  name: Forward
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    label: { $ref: "telo://manifest#/$defs/TextRecord" }
---
kind: Self.Forward
metadata: { name: forwarded }
label:
  text: { plural: n, cases: { one: "{$n} file", other: "{$n} files" } }
  context: null
  lang: en
  computed: false
`,
      }),
    ).toEqual([]);
  });
});

describe("the text walk", () => {
  /** A text, or a text with the values it is formatted with — beside the
   *  members a resource's own value carries. */
  const textOrBound = () => {
    const bound = {
      anyOf: [
        { $ref: "telo://manifest#/$defs/Text" },
        {
          type: "object",
          additionalProperties: false,
          required: ["text", "values"],
          properties: {
            text: { $ref: "telo://manifest#/$defs/Text" },
            values: { type: "object", "x-telo-text-values-for": "/text" },
          },
        },
      ],
    };
    const schema = {
      anyOf: [{ type: "object", additionalProperties: false, properties: { label: bound } }],
    };
    expandManifestFragments(schema);
    return schema;
  };
  const sitesOf = (value: unknown) =>
    textSites(textOrBound(), value, { isExpression: () => false }).texts.map((site) => renderValuePath(site.path));

  it("reads a value only through the union branches it can hold", () => {
    const resource = { kind: "Lib.Label", metadata: { name: "label" } };
    expect(sitesOf({ ...resource, label: { text: "Open", context: "page" } })).toEqual(["label"]);
    expect(sitesOf({ ...resource, label: { text: "{$n} items", values: { n: 3 } } })).toEqual(["label.text"]);
  });
});

describe("x-telo-text-values", () => {
  it("is refused on a text a values pairing already binds", async () => {
    expect(
      await check({
        "/app/telo.yaml": `kind: Telo.Application
metadata:
  name: App
---
kind: Telo.Definition
metadata:
  name: Paired
capability: Telo.Provider
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    text: { $ref: "telo://manifest#/$defs/Text", x-telo-text-values: {} }
    values: { type: object, x-telo-text-values-for: /text }
`,
      }),
    ).toEqual([["TEXT_VALUES_INVALID", "schema.properties.text.x-telo-text-values"]]);
  });
});

describe("a throws code's display message", () => {
  it("names only the required string or number properties of the code's data", async () => {
    expect(
      await check({
        "/app/telo.yaml": `kind: Telo.Application
metadata:
  name: App
lang: en
---
kind: Telo.Definition
metadata:
  name: Lookup
capability: Telo.Invocable
controllers:
  - pkg:npm/none@0.0.0
throws:
  codes:
    NOT_FOUND:
      description: The item does not exist.
      displayMessage: "Item {$id} of {$owner} is {$flag}"
      data:
        type: object
        required: [id, flag]
        properties:
          id: { type: string }
          owner: { type: string }
          flag: { type: boolean }
    FINE:
      description: Every placeholder is filled.
      displayMessage: "Item {$id} is missing"
      data: { type: object, required: [id], properties: { id: { type: integer } } }
`,
      }),
    ).toEqual([
      ["MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED", "throws.codes.NOT_FOUND.displayMessage.flag"],
      ["MESSAGE_PLACEHOLDER_UNBOUND", "throws.codes.NOT_FOUND.displayMessage"],
    ]);
  });
});

describe("a throw step's display message", () => {
  const steps = (body: string) => ({
    "/app/telo.yaml": `kind: Telo.Application
metadata:
  name: App
lang: en
---
kind: Telo.Definition
metadata:
  name: Body
capability: Telo.Runnable
controllers:
  - pkg:npm/none@0.0.0
schema:
  type: object
  properties:
    steps:
      type: array
      items: { $ref: "telo://manifest#/$defs/Step" }
---
kind: Self.Body
metadata:
  name: body
steps:
${body}`,
  });

  it("takes a literal text whose placeholders its data fills, and a caught error's display message", async () => {
    expect(
      await check(
        steps(`  - name: attempt
    try:
      - name: missing
        throw: { code: MISSING, displayMessage: "Item {$id} is missing", data: { id: "42" } }
    catch:
      - name: again
        throw: { code: !cel "error.code", displayMessage: !cel "error.displayMessage", data: !cel "error.data" }
`),
        "/app/telo.yaml",
        /^(MESSAGE_|TEXT_)/,
      ),
    ).toEqual([]);
  });

  it("refuses a text an expression computes, and a placeholder its data does not fill", async () => {
    expect(
      await check(
        steps(`  - name: computed
    throw: { code: MISSING, displayMessage: !cel "'Item ' + 'missing'" }
  - name: unbound
    throw: { code: MISSING, displayMessage: "Item {$id} is missing", data: { other: 1 } }
`),
        "/app/telo.yaml",
        /^(MESSAGE_|TEXT_)/,
      ),
    ).toEqual([
      ["TEXT_ARGUMENT_COMPUTED", "steps[0].throw.displayMessage"],
      ["MESSAGE_PLACEHOLDER_UNBOUND", "steps[1].throw.data"],
    ]);
  });
});
