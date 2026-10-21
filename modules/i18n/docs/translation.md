# Translating texts

> Examples assume this module is imported under the alias `I18n`.

A module writes its texts in one language, named by its `lang:`; catalogs hold their translations into other languages; a translator formats a text in the language a call asks for.

## `I18n.Catalog`

One language's translations. Its whole configuration is the built-in `TextCatalog` shape:

```yaml
kind: I18n.Catalog
metadata: { name: polish }
lang: pl
texts:
  - { text: "Rate not found for {$user}", translation: "Nie znaleziono stawki dla {$user}" }
  - { text: Open, context: verb, translation: Otwórz }
  - { text: Open, context: state, translation: Otwarte }
  - text: { plural: n, cases: { one: "{$n} file", other: "{$n} files" } }
    translation:
      plural: n
      cases: { one: "{$n} plik", few: "{$n} pliki", many: "{$n} plików", other: "{$n} pliku" }
```

| Field | Meaning |
| --- | --- |
| `lang` | The language the translations are written in, a language tag (`pl`, `pt-BR`). |
| `texts[].text` | The source text exactly as the module writing it writes it — a message, plural cases included. |
| `texts[].context` | Optional: tells the same words used for different things apart. An entry translates only the text written with the same context. |
| `texts[].translation` | The message in `lang`. Its shape is free — a plain source may have a plural translation. |

A text is identified by its words and its context: a plural source is identified by the pattern its `other` cases lead to, so `{ plural: n, cases: { one: "{$n} file", other: "{$n} files" } }` and `"{$n} files"` are one text, and `{ $n }` and `{$n}` are one placeholder. Every value is written literally — a catalog holding an expression is refused.

A language pack is a library that imports the module whose texts it translates and exports its catalogs, so `telo check` can tell it a key matches no text that module shows.

## `I18n.Translator`

A CEL function over a set of catalogs:

```yaml
kind: I18n.Translator
metadata: { name: t }
catalogs: [!ref polish, !ref Pack.german]
```

`catalogs` is optional: a translator with none formats every text as written — still with its values, numbers and plural cases.

```yaml
!cel "Self.t('Rate not found for {$user}', inputs.lang, {'user': inputs.user})"
!cel "Self.t({'text': 'Open', 'context': 'verb'}, inputs.lang)"
!cel "Self.t({'plural': 'n', 'cases': {'one': '{$n} file', 'other': '{$n} files'}}, inputs.lang, {'n': size(files)})"
```

| Argument | Meaning |
| --- | --- |
| `text` | The source text, **written at the call** — a message, or `{'text': …, 'context': …}`. It is checked in the calling module's `lang:`, and an expression here is refused: a computed text has no source to look up. |
| `lang` | One language tag. There is no ambient locale: every call says which language. |
| `values` | Optional: a value for every placeholder and plural selector the text reads, by name — a string or a number, a selector a number. |

The call answers a string:

1. The requested tag is tried, then each shorter variant — `pl-Latn-PL`, `pl-Latn`, `pl` — compared without regard to case. The first catalog language translating the text wins, and the translation is formatted in that catalog's language.
2. When no catalog translates it, the source is formatted as written, in the language of the module that wrote it — a Polish source asked for in German still chooses its plural case by Polish rules.

A number is written by the language's CLDR rules (`1234.5` in `pl` is `1234,5`), and its plural case is chosen from the number as written — `=N` cases first, then the language's categories. A placeholder value that is neither a string nor a number is refused.

A translator is called as `Self.<name>(…)` from the module declaring it, and as `<Alias>.<name>(…)` from a module importing a library that lists it in `exports.resources` — the text is still checked in, and attributed to, the module whose expression makes the call.

### A dynamic choice of message

A text is never computed, so choosing a message by a value — an error code to its message — is a CEL map of literal calls, with a fallback for a code it does not hold:

```yaml
message: !cel >-
  {
    'RATE_MISSING': Self.t('Rate not found for {$user}', inputs.lang, {'user': inputs.user}),
    'USER_MISSING': Self.t('No such user: {$user}', inputs.lang, {'user': inputs.user})
  }[?inputs.code].orValue(Self.t('Something went wrong', inputs.lang))
```

### One catalog set

A translator's `catalogs` are one catalog set: across them, one text and context may be translated once per language. Two catalogs of one language translating the same text — a base catalog and a pack, say — is refused at the reference bringing in the later one, by `telo check` — for a translator declared at the top level, in a `with:` scope or as an entry of a template body — and again when the translator is created. The same catalog listed twice is one member, not a duplicate.

## What is checked

| When | Refused |
| --- | --- |
| A catalog entry | a translation reading a placeholder its source lacks; a plural case the catalog's language does not have; a text and context translated twice; an expression anywhere in the catalog |
| A translator's catalogs | a text and context translated twice in one language across them |
| A call | a computed `text`; a `lang` that is not a language tag; a plural case the calling module's language lacks; `values` missing a placeholder or selector the text reads, or holding a value of another type — checked before the app runs when written, when the call is made when computed |
| A module | a plural source in a module declaring no `lang:` |

A catalog entry matching no text the catalog's module, or a module it imports, shows is warned about: its translation is never used. Renaming a shape's `title` leaves the entry that translated the old title warned about at its `text`.
