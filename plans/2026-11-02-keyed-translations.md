---
status: done
priority: high
depends-on: [2026-11-02-application-translations.md]
packages: [analyzer, kernel, sdk]
---

# Keyed translations

Second of four plans. It builds on application translations: the `translations:` block, layering and the controller seam.

## Problem

A library's own texts — a button's "Save", a pager's "1–25 of 340", a validation message per schema keyword — have stable ids and are never written inline. Translated by their source text, they have two problems:

- They collide with the author's texts. Changing the English wording of "Save" is an English → English entry, which also rewrites every "Save" the author wrote.
- Nothing declares them. A library restates its ids in a kind's `required`, its `properties`, its wire enum and its instance (`Ui.Words`, ~90 ids, four times).

## Solution

**A built-in keyed declaration.** A library declares its keys once in a built-in `Telo.KeyedTranslations` document, by convention named `Translations`; in `ui` it declares the kind `Ui.Translations`.

- `keys:` maps each key to its source wording — a message, or `{ message, values?, description? }` — in the module's `lang:`. A module with no `lang:` is `MESSAGE_SOURCE_LANGUAGE_MISSING`.
- `values` declares the placeholders the code showing the text formats it with, in the `x-telo-text-values` vocabulary.
- `description` is a hint for the translator.

**The declared kind.** It extends `Telo.Translations`: `lang` plus `messages:`, a closed map in which every declared key is optional and holds a `Message`, checked against its key's declared values. No key name is reserved. Key completion, the visual editor's form and the refusal of an unknown key all come from that schema.

**Layering.** It is the application translations rule applied per key. A keyed set's source wording is its lowest layer, and each listed catalog of the kind applies over it in `catalogs` order. The placeholder and plural checks hold every layer to its key's declared values and to the catalog's own `lang`.

**What a resource shows is found by reference, never by kind name.** `x-telo-text-keys: [<Alias>.<Kind>, …]` on a kind's schema root names the keyed sets its resources show. It is alias-qualified and canonicalized like `x-telo-ref`. Misplaced, or naming no keyed kind, it is `TEXT_KEYS_INVALID` / `ERR_TEXT_KEYS_INVALID`.

**The seam.** The controller seam gains the layered keyed messages, per set and per served language, for every set the resource's kind names. The controller-protocol message gains them too, in a new generation unless application translations are still unreleased.

**Keys are the convention for a library's own texts, not a rule.** A library may keep some texts as ordinary `Text` values and ship `Telo.TextTranslations` for them.

## Decisions

- **Author texts are translated by text; a library's own texts by key, by convention.**
  - Inline readability and the visual editor need the text where it is shown.
  - Library texts have stable ids, are never written inline, and must not collide with the author's.
  - A library choosing by-text texts accepts that overriding one rewrites an identical author text too.
- **Translations are plain maps typed by a declared kind.** Rejected:
  - `keys: { <Alias>: { … } }` on a catalog.
  - `{ key: Ui.save, translation }` entries.

  Both type a field from other modules' contents.
- **One stem for one family** (`Telo.Translations`, `Telo.TextTranslations`, `Telo.KeyedTranslations`, `<Module>.Translations`), and **each variant names its entries for what they hold**, with only `lang` on the abstract. Rejected:
  - One `entries:` field: a map in one variant, a list in the other.
  - Keys at the top level: every future field becomes a breaking reservation.
  - `translations:` under a `Translations` kind.
- **The source wording is part of the declaration**, so the source language is complete by construction, and an English override collides with nothing.
- **The Rust kernel refuses `Telo.KeyedTranslations`** with `ERR_UNSUPPORTED_MANIFEST_FEATURE` until it reads it.

## Scope

- **Built-in vocabulary:**
  - `Telo.KeyedTranslations` and the kind it declares.
  - `x-telo-text-keys`.
  - Both analyzers' readers.
  - The Node kernel's per-key layering and its extension of the seam and the protocol message.
  - Rows in the check/run agreement suite for `TEXT_KEYS_INVALID`.
- **Tests:** a fixture library declaring its own keys and a kind with `x-telo-text-keys`, whose test controller returns the messages the seam hands it.
- **Docs:** `docs/extend/text-records.md`, the analyzer guide, the controller-protocol guide, the root `CLAUDE.md` Text bullets and annotation list, and the authoring-agent primer.
- **Release bookkeeping:** a changeset for the telo version line.

## Verify

1. A misspelt key, a placeholder outside a key's declared values and a `few` case in an `en` catalog are each refused by `telo check`.
2. A declaration with keys named `lang` and `kind` checks clean. A declaration in a module with no `lang:` is `MESSAGE_SOURCE_LANGUAGE_MISSING`.
3. The fixture kind receives, per served language:
   - the source wording for a key nothing translates;
   - the later catalog's message for a key two catalogs translate;
   - nothing for a set its kind does not name.
4. `x-telo-text-keys` on a nested node, or naming a by-text kind, is refused by `telo check` and by the kernel.
5. The Rust kernel refuses `Telo.KeyedTranslations`.
6. Nothing in the analyzer or the kernel names a library's keyed kind.

## Example after the change

```yaml
kind: Telo.KeyedTranslations
metadata: { name: Translations }
keys:
  save: Save
  pagerRange:
    message: "{$first}–{$last} of {$total}"
    values: { first: { type: integer }, last: { type: integer }, total: { type: integer } }
  minLength:
    message: { plural: limit, cases: { one: "Must be at least {$limit} character", other: "Must be at least {$limit} characters" } }
    values: { limit: { type: integer } }
    description: Shown under a field whose value is too short.
---
kind: Self.Translations
metadata: { name: polishTranslations }
lang: pl
messages:
  save: Zapisz
  pagerRange: "{$first}–{$last} z {$total}"
  minLength: { plural: limit, cases: { one: "Co najmniej {$limit} znak", few: "Co najmniej {$limit} znaki", other: "Co najmniej {$limit} znaków" } }
```
