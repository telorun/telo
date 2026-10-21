# @telorun/message-format

Telo's message core: a closed profile of [Unicode MessageFormat 2](https://www.unicode.org/reports/tr35/tr35-messageFormat.html), read into a plain-JSON model and formatted with pinned CLDR 48.2 data. It has no dependencies and calls no `Intl`, so a message formats identically in Node, in Rust (`telorun-message-format`) and in every browser.

```ts
import { formatMessage, lookupLanguage, readMessage } from "@telorun/message-format";

const read = readMessage({
  plural: "count",
  cases: { "=0": "No files", one: "{$count} file", other: "{$count} files" },
});
if (!read.ok) throw new Error(read.problems[0].message);

formatMessage(read.message, "en", { count: 0n }); // "No files"
formatMessage(read.message, "en", { count: 1234n }); // "1,234 files"
lookupLanguage("pl-PL", ["en", "pl"]); // "pl"
```

## The profile

- **A pattern** is text with `{$name}` placeholders and the escapes `\{`, `\}` and `\\`. A name follows the Telo name rule: a letter or `_` first, then letters, digits or `_`, and not a CEL reserved word. Inside the braces, the whitespace and bidi marks MF2 allows are accepted. Anything else MF2 can write in braces is refused: a literal, a function, an option, an attribute or markup.
- **A plural selection** is written `{ plural: <name>, cases: { <category> | =<integer>: Message } }`. `other` is required. A case is itself a Message, so selections nest. `=N` keys are canonical integers inside int64 ∪ uint64.
- **A text** is a Message, or `{ text: Message, context }` with a non-empty context.

## What it answers

| Function | Answer |
| --- | --- |
| `parsePattern`, `serializePattern` | A pattern's parts, and its one canonical spelling. |
| `readMessage`, `readText` | The model, or every fault as `MESSAGE_SYNTAX_INVALID` with its path and, inside a pattern, its UTF-16 range. |
| `messageIdentity`, `textIdentity` | A source text's key: the pattern reached by taking `other` at every selection, canonically written, plus its context. |
| `messageVariables` | Every placeholder and selector a message reads. |
| `unknownVariables` | `MESSAGE_PLACEHOLDER_UNKNOWN` for each name a translation reads that its source does not. |
| `pluralCategories`, `invalidPluralCategories` | A language's CLDR categories, and `MESSAGE_PLURAL_CATEGORY_INVALID` for each case naming one it lacks. |
| `formatNumber`, `pluralCategory`, `pluralCategoryOfDecimal` | A number's text and category in a language. |
| `formatMessage` | The text. Refuses with `MESSAGE_PLACEHOLDER_UNBOUND` when a name the message reads has no value, on any branch. Refuses with `MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED` for a value other than a string or a number, and for a selector that is not a number. |
| `truncationChain`, `lookupLanguage` | RFC 4647 lookup: `pl-Latn-PL` → `pl-Latn` → `pl`, case-insensitive. `null` when nothing matches, and the caller then uses its source. |

## Numbers

A number's text depends on its value alone, never on its host type:

- A `bigint` inside int64 ∪ uint64 is written exactly, however large.
- A `number` is a double: its shortest round-trip decimal, rounded half-to-even to the pattern's maximum fraction digits, with trailing zeros dropped and a zero result unsigned. So `1.0` is "1", and in `en` it selects `one`.
- A non-finite double is refused.

The text then takes the language's CLDR standard decimal pattern, grouping (with `minimumGroupingDigits`), default-numbering digits, decimal separator and minus sign. Plural selection reads the operands of that rounded decimal. `=N` cases match numerically before the categories.

## CLDR data

The data is CLDR 48.2 for every locale, generated into `message-format/cldr/` from the exact-pinned `cldr-core` and `cldr-numbers-full`. A tag resolves through CLDR's own inheritance and ends at the root (`other` only, Latin digits, `#,##0.###`):

- **Number data** goes through `parentLocales`, then the `nonlikelyScript` rule, then truncation.
- **Plural rules** go through CLDR's plurals parent map.

The data is used under the Unicode License V3. The package ships the licence as `LICENSE-CLDR`, and every build of the core carries it as a `/*! */` notice that survives bundling.
