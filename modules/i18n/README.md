# I18n

Answer people in their own language: write each text once in your module's language, list its translations once in the application, and format it — values, numbers and plural cases included — in whatever language a request asks for. `I18n.translate` is a CEL function, so a translated text is one expression wherever an expression is allowed: an email body, an API error, a page label.

## Why use this

- **Texts are checked before the app runs** — a translation using a placeholder its source lacks, a plural case its language does not have, a text translated twice in one list, or a computed text where a written one belongs is refused by `telo check`.
- **Plurals and numbers follow the language** — Polish `1 plik`, `3 pliki`, `5 plików` come from one message with CLDR plural rules and number formatting, the same in every runtime and every browser.
- **Graceful fallback** — `pl-PL` is served by `pl`, and a language nothing translates gets the source text, formatted by its own language's rules.
- **One set for the application** — the translations are the application's own `translations:` block, so a library's texts and the application's are translated by the same catalogs, with later ones overriding earlier ones.
- **No ambient locale** — the language is an argument of every call, so nothing about a request leaks into another.

## Kinds and instances

| Name | What it is |
| --- | --- |
| `I18n.translate` | The exported function: `I18n.translate(text, lang, values?)` → the text translated by the application's translations and formatted. |
| `I18n.Catalog` | Deprecated: `lang` and `texts`, as `Telo.TextTranslations`, which replaces it. It can still be listed in `translations:`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: Rates, version: 1.0.0 }
lang: en
imports:
  I18n: oci://ghcr.io/telorun/i18n@<version>
translations:
  catalogs:
    - kind: Telo.TextTranslations
      lang: pl
      texts:
        - { text: "Rate not found for {$user}", translation: "Nie znaleziono stawki dla {$user}" }
        - text: { plural: n, cases: { one: "{$n} file", other: "{$n} files" } }
          translation:
            plural: n
            cases: { one: "{$n} plik", few: "{$n} pliki", many: "{$n} plików", other: "{$n} pliku" }
```

```yaml
!cel "I18n.translate('Rate not found for {$user}', 'pl', {'user': 'Ala'})"    # Nie znaleziono stawki dla Ala
!cel "I18n.translate({'plural': 'n', 'cases': {'one': '{$n} file', 'other': '{$n} files'}}, 'pl-PL', {'n': 5})"   # 5 plików
```

The Rust kernel refuses `translations:`, so an application using it runs on the Node kernel.

## Reference

- [Translating texts](docs/translation.md) — the application's translations, the function's call and lookup, a dynamic choice of message, and what is checked.
