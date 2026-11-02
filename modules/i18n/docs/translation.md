# Translating texts

> Examples assume this module is imported under the alias `I18n`.

A module writes its texts in one language, named by its `lang:`. The application lists their translations once, and `I18n.translate` formats a text in the language a call asks for.

## The application's translations

The root `Telo.Application` lists its translations in `translations.catalogs`; each entry is a `!ref` or an inline resource of a `Telo.Translations` kind, such as the built-in `Telo.TextTranslations`:

```yaml
translations:
  catalogs:
    - kind: Telo.TextTranslations
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

A text is identified by its words and its context: a plural source is identified by the pattern its `other` cases lead to, so `{ plural: n, cases: { one: "{$n} file", other: "{$n} files" } }` and `"{$n} files"` are one text, and `{ $n }` and `{$n}` are one placeholder. Every value is written literally.

Per language, entries apply in `catalogs` order and a later one wins, per text and context, so a pack can override one translation of a base catalog. A text translated twice within one catalog is refused. A library may ship translations as an exported resource of a `Telo.Translations` kind, which the application lists with `!ref <Alias>.<name>`; a library's texts are translated by the importing application's set.

`I18n.Catalog` is the deprecated spelling of `Telo.TextTranslations`: it is listed in `translations:` the same way and takes part in the same layering, and reports `DEPRECATED_KIND`.

## `I18n.translate`

```yaml
!cel "I18n.translate('Rate not found for {$user}', inputs.lang, {'user': inputs.user})"
!cel "I18n.translate({'text': 'Open', 'context': 'verb'}, inputs.lang)"
!cel "I18n.translate({'plural': 'n', 'cases': {'one': '{$n} file', 'other': '{$n} files'}}, inputs.lang, {'n': size(files)})"
```

| Argument | Meaning |
| --- | --- |
| `text` | The source text, **written at the call** — a message, or `{'text': …, 'context': …}`. It is checked in the calling module's `lang:`, and an expression here is refused: a computed text has no source to look up. |
| `lang` | One language tag, usually `request.lang`. There is no ambient locale: every call says which language. |
| `values` | Optional: a value for every placeholder and plural selector the text reads, by name — a string or a number, a selector a number. |

The call answers a string:

1. The requested tag is matched against the languages the application serves by lookup, dropping subtags from the end — `pl-Latn-PL`, `pl-Latn`, `pl` — and the layered translation is formatted in the language reached.
2. When nothing translates it there, the source is formatted as written, in the language of the module that wrote it — a Polish source asked for in German still chooses its plural case by Polish rules.

A number is written by the language's CLDR rules (`1234.5` in `pl` is `1234,5`), and its plural case is chosen from the number as written — `=N` cases first, then the language's categories. A placeholder value that is neither a string nor a number is refused.

The function is the module's exported instance `translate`, called as `I18n.translate(…)` from a module importing it — the text is checked in, and attributed to, the module whose expression makes the call. It reads the application's translations, so a call made while the application is still starting, before its catalogs exist, fails as `ERR_FUNCTION_FAILED`; call it from request handling or from resources initialized after the catalogs.

### A dynamic choice of message

A text is never computed, so choosing a message by a value — an error code to its message — is a CEL map of literal calls, with a fallback for a code it does not hold:

```yaml
message: !cel >-
  {
    'RATE_MISSING': I18n.translate('Rate not found for {$user}', inputs.lang, {'user': inputs.user}),
    'USER_MISSING': I18n.translate('No such user: {$user}', inputs.lang, {'user': inputs.user})
  }[?inputs.code].orValue(I18n.translate('Something went wrong', inputs.lang))
```

## What is checked

| When | Refused |
| --- | --- |
| A translation entry | a translation reading a placeholder its source lacks; a plural case the language does not have; a text and context translated twice in one list; an expression anywhere in it |
| A call | a computed `text`; a `lang` that is not a language tag; a plural case the calling module's language lacks; `values` missing a placeholder or selector the text reads, or holding a value of another type — checked before the app runs when written, when the call is made when computed |
| A module | a plural source in a module declaring no `lang:` |

An entry matching no text the module, or a module it imports, shows is warned about: its translation is never used.
