# I18n

Answer people in their own language: write each text once in your module's language, keep its translations in catalogs, and format it — values, numbers and plural cases included — in whatever language a request asks for. A translator is a CEL function, so a translated text is one expression wherever an expression is allowed: an email body, an API error, a page label.

## Why use this

- **Texts are checked before the app runs** — a translation using a placeholder its source lacks, a plural case its language does not have, a text translated twice in one language across a translator's catalogs, or a computed text where a written one belongs is refused by `telo check`.
- **Plurals and numbers follow the language** — Polish `1 plik`, `3 pliki`, `5 plików` come from one message with CLDR plural rules and number formatting, the same in every runtime and every browser.
- **Graceful fallback** — `pl-PL` falls back to `pl`, and a language no catalog has gets the source text, formatted by its own language's rules.
- **Negotiation built in** — pick the language to answer in from an `Accept-Language` header, by quality, with malformed ranges skipped rather than refused.
- **No ambient locale** — the language is an argument of every call, so nothing about a request leaks into another.

## Kinds

| Kind | What it is |
| --- | --- |
| `I18n.Catalog` | One language's translations: `lang`, and `texts` of `{ text, context?, translation }`. |
| `I18n.Translator` | A function over a set of catalogs: `Self.t(text, lang, values?)` → the translated, formatted text. |
| `I18n.Negotiator` | A function over a translator: `Self.language(acceptLanguage)` → the language tag to answer in. |

## Example

```yaml
kind: Telo.Application
metadata: { name: Rates, version: 1.0.0 }
lang: en
imports:
  I18n: oci://ghcr.io/telorun/i18n@<version>
---
kind: I18n.Catalog
metadata: { name: polish }
lang: pl
texts:
  - { text: "Rate not found for {$user}", translation: "Nie znaleziono stawki dla {$user}" }
  - text: { plural: n, cases: { one: "{$n} file", other: "{$n} files" } }
    translation:
      plural: n
      cases: { one: "{$n} plik", few: "{$n} pliki", many: "{$n} plików", other: "{$n} pliku" }
---
kind: I18n.Translator
metadata: { name: t }
catalogs: [!ref polish]
---
kind: I18n.Negotiator
metadata: { name: language }
translator: !ref t
default: en
```

```yaml
!cel "Self.t('Rate not found for {$user}', 'pl', {'user': 'Ala'})"    # Nie znaleziono stawki dla Ala
!cel "Self.t({'plural': 'n', 'cases': {'one': '{$n} file', 'other': '{$n} files'}}, 'pl-PL', {'n': 5})"   # 5 plików
!cel "Self.language('de;q=0.9, pl;q=0.8')"                             # pl
```

## Reference

- [Translating texts](docs/translation.md) — catalogs, the translator's call and lookup, a dynamic choice of message, catalog sets, and what is checked.
- [Answering in the caller's language](docs/negotiation.md) — the negotiator, and an API that negotiates once per request.
- [Reading a catalog set from another module](docs/catalog-set.md) — `@telorun/i18n` for a controller holding a translator.
