# Built-in translations

One JSON file per language, `<lang>.json`, translating the display messages of
the built-in error codes (`sdk/error-codes/`) into that language. Each file is a
text catalog, exactly what a `Telo.TextTranslations` resource holds:

| key     | meaning |
| ------- | ------- |
| `lang`  | The language the translations are written in, the file name without `.json`. Never `en`, the language the display messages are written in. |
| `texts` | One `{ text, context?, translation }` per built-in display message: `text` and `context` are the message as its entry writes it, `translation` the Message translating it. |

The `Telo.Builtins` archive carries them, verbatim, as its `translations`
section keyed by language; the renderer also writes them into `@telorun/analyzer`
(`BUILTIN_TRANSLATION_FILES`), which is what the kernel and `telo check` layer.
`readBuiltinVocabulary` refuses a catalog that is not a text
catalog, whose key is not its `lang`, written in `en`, translating a text no
built-in error code shows, or leaving one of them untranslated.

They are the lowest layer of every application's translations, beneath every
catalog the Application lists in `translations.catalogs`: a listed catalog
translating the same text and context wins. They never add a served language — an
application serves its own `lang:` and its listed catalogs' languages only — so
an application written in Polish shows a built-in failure in Polish with no
catalog listed, while an English one asked for Polish answers in English.
`telo check` counts them when it reports `MESSAGE_TRANSLATION_MISSING`, so an
application serving one of these languages is never warned about a built-in
text.

The languages are those the `ui` module ships its own texts in. Adding one is a
new file here; changing a built-in display message means changing its
translation in every file.
