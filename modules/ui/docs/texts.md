# Texts and translation

Every text a screen shows is a [`Text`](https://telo.run/docs/extend/text-records),
written in the language its module declares with `lang:` — so a renderer with a
translator can show it in the language a request asks for, and `telo check`
judges each one where it is written.

## What is a text

| Where | Typed |
| --- | --- |
| a node's `text`, `badge`, link `text`, `alt`, a value's `text`, a list's `heading`, a column's `header` | `Ui.BoundText` |
| an enablement's `disabledText`, a row action's `confirm` | `Ui.BoundText`, not empty |
| an action's `label`, a table layout column's `header`, a group's `label` and `description`, a preset's `label` | `Text`, formatted with no values |
| a model's `title`, `description` and the `title` of an enumeration's `const` branch | the schema's own texts |

A `Text` formatted with no values may not name a placeholder: `Hello {$name}` as
an action's label is refused by `telo check`.

## A text over data

`Ui.BoundText` is a `Text`, or `{ text, values }` — a text with placeholders and
the [accessors](https://telo.run/docs/extend/accessor-fields) that fill them,
read in the browser over the roots in scope:

```yaml
- type: text
  text:
    text: { plural: n, cases: { one: "{$n} unpaid invoice", other: "{$n} unpaid invoices" } }
    values: { n: !cel "data.unpaid" }
```

The page composes the sentence, so a translation picks the right plural form for
the number the browser reads — "3 nieopłacone faktury", "5 nieopłaconych faktur"
— and the backend never assembles words. Every placeholder must be bound by
`values` and every plural selector must read a number; a missing one is refused
by `telo check`, and `values` binds nothing the text does not name.

## `ui`'s own texts

What a renderer draws on its own — "Loading…", "Save", a pager's
"1–25 of 340", each validation message — and what `ui` fills in for you — a
reader's `loading`, a listing's `empty` — are `ui`'s own texts. They are
declared by key in `ui`'s `Telo.KeyedTranslations` document `Translations`,
which declares the kind `Ui.Translations`: each key with its English wording
and the values it is formatted with. An application writes nothing to show
them in English.

`ui` ships them translated, one exported `Ui.Translations` per language:

| Language | Resource |
| --- | --- |
| Chinese (`zh`) | `Ui.chineseTranslations` |
| Dutch (`nl`) | `Ui.dutchTranslations` |
| French (`fr`) | `Ui.frenchTranslations` |
| German (`de`) | `Ui.germanTranslations` |
| Hindi (`hi`) | `Ui.hindiTranslations` |
| Italian (`it`) | `Ui.italianTranslations` |
| Japanese (`ja`) | `Ui.japaneseTranslations` |
| Korean (`ko`) | `Ui.koreanTranslations` |
| Polish (`pl`) | `Ui.polishTranslations` |
| Portuguese (`pt`) | `Ui.portugueseTranslations` |
| Russian (`ru`) | `Ui.russianTranslations` |
| Spanish (`es`) | `Ui.spanishTranslations` |
| Turkish (`tr`) | `Ui.turkishTranslations` |
| Ukrainian (`uk`) | `Ui.ukrainianTranslations` |

An application lists the languages it serves in its `translations:` block. To
change a wording, list a `Ui.Translations` of your own after the shipped one:
only the keys it names change, and no text the author wrote is touched — an
author's own "Save" stays as it is. One in `lang: en` changes the English
wording.

```yaml
kind: Telo.Application
metadata: { name: Invoices, version: 1.0.0 }
lang: en
imports: { Ui: oci://ghcr.io/telorun/ui@0.9.0 }
translations:
  catalogs:
    - !ref Ui.polishTranslations
    - !ref wording
---
kind: Ui.Translations
metadata: { name: wording }
lang: pl
messages:
  save: Zachowaj
```

A key the declaration does not have, a placeholder outside its key's values and
a plural case the catalog's language does not have are refused by
`telo check`. A key nothing translates into a served language is shown in
English.

A kind showing these texts names the set with `x-telo-text-keys` on its
schema root: `Ui.Data` and `Ui.Listing`, which fill `loading` and `empty`, name
`[Self.Translations]`, and a renderer's application names `[Ui.Translations]` to
receive the messages of every served language.

| Key | English |
| --- | --- |
| `loading` | Loading… |
| `noRows` | No rows. |
| `nothingFound` | Nothing found. |
| `save` | Save |
| `cancel` | Cancel |
| `close` | Close |
| `newRecord` | New |
| `edit` | Edit |
| `delete` | Delete |
| `deleteRowQuestion` | Delete this row? |
| `deleteRowDetail` | This cannot be undone. |
| `previousPage` | Previous page |
| `pagerRange` | {$first}–{$last} of {$total} |
| `pagerEmpty` | 0 of {$total} |
| `nextPage` | Next page |
| `loadMore` | Load more |
| `moveTo` | Move to |
| `valueCount` | {$label} ({$count}) — a value offered with how many records hold it |
| `yes` | Yes |
| `no` | No |
| `none` | None |
| `any` | Any |
| `select` | Select… |
| `choose` | Choose… |
| `more` | More |
| `menu` | Menu |
| `siteNavigation` | Site |
| `collapseNavigation` | Collapse navigation |
| `expandNavigation` | Expand navigation |
| `search` | Search {$label} |
| `remove` | Remove {$label} |
| `clear` | Clear {$label} |
| `filters` | Filters |
| `addFilter` | Add filter |
| `apply` | Apply |
| `reset` | Reset |
| `done` | Done |
| `presets` | Presets |
| `operatorEq` | is |
| `operatorContains` | contains |
| `operatorGt` | after |
| `operatorGte` | from |
| `operatorLt` | before |
| `operatorLte` | to |
| `operatorIn` | one of |
| `operatorAbsent` | not set |
| `filterControl` | {$label} {$operator} |
| `filterChip` | {$label} {$operator} {$value} |
| `filterGroupSummary` | {$label}: {$summary} |
| `rangeFrom` | From |
| `rangeTo` | To |
| `rangeStartsAfterEnd` | Must not start after it ends |
| `rangeLongerThanDays` | `one`: Longer than {$count} day; `other`: Longer than {$count} days — plural over `count` |
| `rangeLongerThanWeeks` | `one`: Longer than {$count} week; `other`: Longer than {$count} weeks — plural over `count` |
| `rangeLongerThanMonths` | `one`: Longer than {$count} month; `other`: Longer than {$count} months — plural over `count` |
| `rangeLongerThanQuarters` | `one`: Longer than {$count} quarter; `other`: Longer than {$count} quarters — plural over `count` |
| `rangeLongerThanYears` | `one`: Longer than {$count} year; `other`: Longer than {$count} years — plural over `count` |
| `notFound` | Not found |
| `noPageAt` | This application has no page at {$path}. |
| `unsavedQuestion` | Discard unsaved changes? |
| `unsavedDetail` | What you entered has not been saved. |
| `discard` | Discard |
| `keepEditing` | Keep editing |
| `requestUnauthorized` | You are not signed in, or your session has ended. |
| `requestForbidden` | You are not allowed to do this. |
| `requestFailedStatus` | The request failed with status {$status}. |
| `requestFailed` | The request failed: {$reason} |
| `recordRefused` | The record was refused. |
| `answerNotJson` | The answer is not JSON. |
| `answerNotObject` | The answer is not a JSON object. |
| `answerNotModel` | The answer does not fit its model: {$detail} |
| `invalid` | Is not valid |
| `required` | Is required |
| `type` | Must be {$types} |
| `enum` | Must be one of: {$allowed} |
| `const` | Must be {$value} |
| `not` | Is not allowed |
| `anyOf` | Is not one of the allowed forms |
| `minLength` | `one`: Must be at least {$limit} character; `other`: Must be at least {$limit} characters — plural over `limit` |
| `maxLength` | `one`: Must be at most {$limit} character; `other`: Must be at most {$limit} characters — plural over `limit` |
| `pattern` | Is not in the expected format |
| `minimum` | Must be at least {$limit} |
| `maximum` | Must be at most {$limit} |
| `exclusiveMinimum` | Must be greater than {$limit} |
| `exclusiveMaximum` | Must be less than {$limit} |
| `multipleOf` | Must be a multiple of {$limit} |
| `minItems` | `one`: Must have at least {$limit} item; `other`: Must have at least {$limit} items — plural over `limit` |
| `maxItems` | `one`: Must have at most {$limit} item; `other`: Must have at most {$limit} items — plural over `limit` |
| `uniqueItems` | Must not repeat an item |
| `minProperties` | `one`: Must have at least {$limit} entry; `other`: Must have at least {$limit} entries — plural over `limit` |
| `maxProperties` | `one`: Must have at most {$limit} entry; `other`: Must have at most {$limit} entries — plural over `limit` |
| `format` | Is not a valid {$format} |
| `additionalProperties` | Is not expected here |
| `propertyNames` | Has a name that is not allowed: {$propertyName} |

The keys from `invalid` to the end are the validation texts: what the
browser's own validation says of a keyword, and what a renderer says of each
issue of a 400 problem (`data.issues`, `{ pointer, keyword, params }`), so a
refusal the API finds reads as one the browser finds. Every keyword an
`Http.Api` issue may carry has one; an issue's `params` are its values —
`type`'s `types` from `type`, `enum`'s `allowed` from `allowedValues`, `const`'s
`value` from `allowedValue`, `multipleOf`'s `limit` from `multipleOf`, the
rest by their own names.

## What a renderer receives

A provided node carries each text as a **text record** —
`{ text, context, lang, computed }`, the same record a controller receives —
typed by the built-in `TextRecord` fragment; a `{ text, values }` text is the
record with `values` beside it, each value a binding; a text `ui` fills itself
is the keyed text `{ set: Ui.Translations, key }`, which a renderer shows as
that set's message for the key in the request's language. A model's title, description and enumeration labels are records
of language `und`: they are matched against a catalog by their words.

- Every `value` node, `list` column, table layout column, filter field and form or
  action field carries `labels: [{ value, label }]` — the label of each value an
  enumeration offers, `[]` when none — so a value is shown by its label while
  the value sent back is unchanged.
- Every field carries `description`: the property's description as a record,
  drawn as a hint, or `null`.
- A date range's `initialPreset` is the index of its preset, or `null`.

`SpecTranslator`, exported by [`@telorun/ui`](composite.md#for-a-renderers-controller-telorunui),
walks a provided node by `Ui.SpecNode` — never by a value's shape — and hands a
renderer each record to translate, so a renderer's controller replaces every
text without knowing where the vocabulary keeps one.
