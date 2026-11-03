# Missing-translation reporting

Last of four plans. It builds on application translations, keyed translations and `ui` texts by key.

## Problem

- A missing translation is reported nowhere: the screen silently shows English among Polish words.
- The built-in error codes' display messages exist only in English, so a Polish caller reads an English problem `detail` unless every application translates them.

## Solution

**`MESSAGE_TRANSLATION_MISSING`** is a **warning** at `telo check`. One reader over the whole application computes it on the layered result. For each served language other than `und` (a regional tag being covered by its shorter variants), the following must be translated:

- every key of every keyed set any resource reaches;
- every non-computed `Text` written in another language that the application can show: UI texts, `throws.codes.*.displayMessage`, and the literal `text` of `I18n.translate` calls.

The warning is reported as one diagnostic per (language, keyed set), plus one per language for by-text texts, each listing what is missing. It is reported at the Application's `translations` key, or at its `lang:` when the block is absent. At run time nothing is refused: a missing translation shows the source.

**Built-in error messages arrive translated.** The display messages of the built-in error codes (`sdk/error-codes/`) gain translations into the 14 languages `ui` ships. They are carried in the built-in vocabulary as the lowest layer of every application's set, beneath every listed catalog.

**A library proves its own translations complete** through a fixture application in its tests. `ui` gains one that lists every shipped translation.

## Decisions

- **A missing translation is a warning**, and the source is shown: a partly translated application is normal while it is being translated.

## Scope

- **Analyzer:** the reader and `MESSAGE_TRANSLATION_MISSING`.
- **Built-in vocabulary:** the error-message translations as the lowest layer, and the Node kernel applying them.
- **`ui`:** the completeness fixture application in its tests.
- **Docs:** `docs/extend/text-records.md`, `ui/docs/texts.md`, the analyzer guide, the root `CLAUDE.md` Text bullets, the authoring-agent primer, and benefits-ledger entries:
  - built-in error texts arrive translated;
  - an untranslated text is reported before the app runs.
- **Release bookkeeping:** a changeset for the telo version line, and a fragment for `ui`.

## Verify

1. Removing a by-text UI text or the `I18n.translate` text from a Polish catalog gives one `MESSAGE_TRANSLATION_MISSING` warning naming it. The app still boots and shows the source.
2. Removing `Ui.polishTranslations` from an app serving `pl` gives one warning naming `Ui.Translations` and every key it lacks.
3. An app serving `pl-PL` and `pl` is warned only once per missing entry. An English-only app is warned about nothing.
4. A built-in error code's display message reaches a Polish caller in Polish, with no catalog listed. A listed catalog translating the same message wins.
5. `ui`'s fixture application checks with no warning.
