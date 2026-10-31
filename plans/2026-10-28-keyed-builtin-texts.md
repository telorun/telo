# Keyed built-in texts and application translations

## Problem

A library shows texts no author writes — `ui`'s "Save", "Delete this row?", the pager's "1–25 of 340", a validation message per schema keyword. Today they are the `Ui.Words` kind (~90 ids, each restated in its `required`, its `properties`, the wire's word enum and the instance) with one English instance, `Ui.words`, and:

- every UI app must write `words: !ref Ui.words` and `translator: !ref <I18n.Translator>`, plus an `I18n.Negotiator` and a `lang:` expression to pick a language;
- a word is translated by its English text: id → English → catalog entry `{ text: Save, translation: Zapisz }`, so changing the English wording is an English → English entry, which also rewrites every "Save" the author wrote;
- an API translating with `Self.t` lists the same catalogs again on its own translator, under a different rule (a translator refuses a text translated twice; nothing else layers), and negotiates the language in author-written CEL;
- a missing translation is reported nowhere: the screen silently shows English among Polish words;
- every app translates `ui`'s words itself — the showcase carries all ~90 in each of its 14 language files;
- translations by text are a kind of the `i18n` module, so a library shipping its own must import `i18n` to describe them.

## Solution

**Two built-in translation kinds under one built-in abstract.** `Telo.Translations` — translations into one language — declares only `lang` (a language tag, required). Its variants name their entries for what they hold:

- **By text**: `Telo.TextTranslations` — `lang` and `texts:`, a list of `{ text, context?, translation }` matched by source text and context; the shape `I18n.Catalog` has today. `I18n.Catalog` is deprecated with `replacedBy: Telo.TextTranslations` and keeps working.
- **By key**: a library declares its keys once in a built-in `Telo.KeyedTranslations` document, by convention named `Translations` — in `ui` it declares the kind `Ui.Translations`. `keys:` maps each key to its source wording — a message, or `{ message, values?, description? }` — in the module's `lang:` (none is `MESSAGE_SOURCE_LANGUAGE_MISSING`). `values` declares the placeholders the shower formats with, in the `x-telo-text-values` vocabulary; `description` is a translator's hint. The declared kind extends `Telo.Translations`: `lang` plus `messages:`, a closed map in which every declared key is optional and is a `Message` held to its declared values. No key name is reserved. Key completion, the visual editor's form and the refusal of an unknown key all come from that schema.

**Keys are the convention for a library's own texts, not a rule.** A library may keep some texts as ordinary `Text` values and ship `Telo.TextTranslations` for them. `ui` uses keys throughout and ships and exports one `Ui.Translations` per language — `Ui.germanTranslations`, `Ui.polishTranslations`, … — for the 14 languages the showcase translates today, moved out of the showcase. The built-in error codes' display messages (`sdk/error-codes/`) gain translations into the same 14 languages, shipped in the built-in vocabulary as the lowest layer of every application's set.

**The application declares its translations once**: an Application-only `translations: { catalogs: [...] }` block, each entry a `!ref` or an inline `Telo.Translations` resource, resolved at load before any resource exists, like `logging:`. A `Telo.Library` writing it is refused as `tracing:` is; each `App.Instance` child has its own. **Served languages** are the Application's `lang:` (the fallback; `und` when absent) plus every listed catalog's `lang`. **Layering is the one rule for every catalog**: per language, entries apply in `catalogs` order and a later one wins — per key for a keyed set, per text and context by text; a keyed set's source wording and the built-in error-message translations are the lowest layers. Twice within one catalog stays `MESSAGE_ENTRY_DUPLICATE`; across catalogs it is an override. `x-telo-text-catalog-set` and `TEXT_CATALOG_SET_INVALID` leave the vocabulary. A library's texts are translated by the importing application's set, the same for an isolated or a shared import.

**The transport chooses the language.** The kernel offers one negotiation: an ordered preference list matched against the served languages by RFC 4647 lookup (`pl-PL` finds `pl`), landing on the fallback. Every inbound transport exposes its result as `lang` on its inbound context — a language tag, always present. For HTTP it is **`request.lang`**, in every request context the http-server kinds declare (route `inputs` / `returns` / `catches`, router and server `catches`, guards), negotiated once per request before the guard. `Http.Server.preferredLanguages` (optional) is a CEL expression over `request` (no `lang`) returning tags in preference order — a cookie, a path prefix, a query parameter; they are tried first, then `Accept-Language` by quality, then the fallback; malformed or unserved entries are skipped, never refused. With more than one served language, a response whose production read the language carries `Content-Language` and `Vary: Accept-Language` plus every header `preferredLanguages` reads (`Vary: *` for a computed name); a problem's `detail` is formatted in `request.lang`. `UiReact.App` loses `catalogs:`, `lang:`, `translator:` and `words:`, reads `request.lang`, and keeps one copy of each document per served language.

**What a resource shows is found by reference, never by kind name.** `x-telo-text-keys: [<Alias>.<Kind>, …]` on a kind's schema root names the keyed sets its resources show (alias-qualified, canonicalized like `x-telo-ref`; misplaced or naming no keyed kind is `TEXT_KEYS_INVALID` / `ERR_TEXT_KEYS_INVALID`). `ui`'s kinds that fill texts declare `[Self.Translations]`, `UiReact.App` `[Ui.Translations]`. The kernel hands a controller, through one seam — also a message of the controller protocol, in a new generation — the served languages, the fallback, the negotiation, by-text lookup and the layered keyed messages per set and language. On the wire a keyed text is `{ set: <canonical kind>, key }` and the renderer receives one message map per set, so it draws any library's keyed texts without naming `Ui.Translations`.

**Translating outside the UI**: `I18n.Negotiator` is removed; `I18n.Translator` loses `catalogs`, stops being exported, and backs one exported instance, **`translate`**, over the application's set: `I18n.translate('Invoice {$number} is overdue', request.lang, {'number': inputs.number})`. The `text` stays a literal `Text`, checked in and attributed to the calling module; `lang` stays an explicit argument and the function stays deterministic.

**`MESSAGE_TRANSLATION_MISSING`** is a **warning** at `telo check`, computed on the layered result by one reader over the whole application: for each served language other than `und` — a regional tag covered by its shorter variants — every key of every keyed set any resource reaches, and every non-computed `Text` written in another language the application can show (UI texts, `throws.codes.*.displayMessage`, the literal `text` of `I18n.translate` calls), must be translated. One diagnostic per (language, keyed set) and one per language for by-text texts, each listing what is missing, at the Application's `translations` key (at its `lang:` when the block is absent). At run time nothing is refused: a missing translation shows the source. The placeholder and plural checks hold every layer of a keyed catalog to its key's declared values and its own `lang`. A library proves its own translations complete through a fixture application in its tests.

## Decisions

- **Author texts are translated by text; a library's own texts by key, by convention.** Inline readability and the visual editor need the text where it is shown; library texts have stable ids, are never written inline, and must not collide with the author's — a library choosing by-text texts accepts that an override of one rewrites an identical author text too.
- **Translations are plain maps typed by a declared kind.** Rejected: `keys: { <Alias>: { … } }` on a catalog and `{ key: Ui.save, translation }` entries — both type a field from other modules' contents.
- **Both translation kinds, the declaration and the block are built in**, so a library depends on nothing to declare or ship translations and the analyzer never reads an `i18n` kind name.
- **One stem for one family** (`Telo.Translations`, `Telo.TextTranslations`, `Telo.KeyedTranslations`, `<Module>.Translations`), and **each variant names its entries for what they hold**, only `lang` on the abstract. Rejected: one `entries:` field (a map in one variant, a list in the other), keys at the top level (every future field a breaking reservation), `translations:` under a `Translations` kind.
- **The source wording is part of the declaration**, so it is complete by construction and an English override collides with nothing.
- **Overrides are layers in `translations.catalogs` order**, for every catalog — the Django `LOCALE_PATHS` / Helm values model. Rejected: `from:` (keyed maps only) and CEL `merge()` (computed, so unchecked). An accidental repeat across catalogs silently wins; the editor marks the shadowed entry.
- **The set is the application's, the choice the transport's** — Django, ASP.NET Core, Rails, Next.js and Spring all split it so. Rejected: `languages:` on `Http.Server` (every server and transport restates the list, and can disagree with the catalogs), `catalogs:` on the App plus a separate translator (the set listed twice under two rules, `Self.t` texts unchecked, negotiation in author CEL), and one built-in translations resource each consumer references (a slot on every consumer, and two sets possible). One application serves one language set on all its surfaces.
- **The language is an explicit argument, never ambient** — no per-thread state exists in the step engine, durable replay or another kernel, and a deterministic function must not read hidden input.
- **`translate` stays a module function**, not a core CEL function: the core catalog holds no host vocabulary and could not check a literal `Text` argument.
- **A missing translation is a warning**, and the source is shown: a partly translated application is normal while it is being translated.
- **No load-time migration**: in-repo manifests are rewritten in the same change.
- **The Rust kernel refuses `translations:`, `Telo.KeyedTranslations` and `Telo.TextTranslations`** with `ERR_UNSUPPORTED_MANIFEST_FEATURE` until it reads them.

## Scope

- Built-in vocabulary: `Telo.Translations`, `Telo.TextTranslations`, `Telo.KeyedTranslations`, the Application `translations:` block (refused on Library), `x-telo-text-keys`, the error-message translations; `x-telo-text-catalog-set` removed; both analyzers' readers; the Node kernel's controllers and seam, and its controller-protocol message; rows in the check/run agreement suite for `TEXT_KEYS_INVALID` and `translations:` on a Library.
- `ui`: `Ui.Words` / `Ui.words` replaced by the `Translations` declaration, the 14 shipped translations, `x-telo-text-keys`, the `{ set, key }` wire shape, a fixture app listing every shipped translation so `ui`'s own suite proves them complete.
- `ui-react`: `request.lang`, the keyed message maps on the wire; `catalogs`, `lang`, `translator`, `words` removed.
- `http-server`: `preferredLanguages`, `request.lang` in every request context, `Content-Language` / `Vary`, problem `detail` in `request.lang`.
- `i18n`: `Negotiator` removed, `Translator` behind the exported `translate`, `I18n.Catalog` deprecated.
- `requires: telo:` floors on `ui`, `ui-react`, `i18n` and `http-server`, each verified by running the previous CLI (`run`, for the two reading the new seam).
- Every manifest writing `words:`, a UI `translator:` / `lang:`, a negotiator or `I18n.Catalog`; docs (`ui/docs/texts.md`, the `ui-react`, `i18n` and `http-server` docs, `docs/extend/text-records.md`, the analyzer guide, the root `CLAUDE.md` Application and Text bullets), the authoring-agent primer, the hub's `build-ui` guide, and a benefits-ledger entry: built-in UI and error texts arrive translated, the request language is chosen for you with `Content-Language` / `Vary` set, and an untranslated text is reported before the app runs.
- Release bookkeeping: a changeset for the telo version line, a fragment per module.

## Verify

1. An English-only app with no `translations:` passes `telo check` clean, shows "Save", and its responses carry no language `Content-Language` / `Vary`.
2. The example below: `Accept-Language: pl` shows "Zachowaj" in the form and answers the API in Polish with `Content-Language: pl` and `Vary: Accept-Language`; `?lang=pl` does the same and `Vary` adds nothing for the query; `de` answers English with "Submit"; an author-written "Save" is untouched; nothing lists the catalogs twice.
3. Removing a UI text or the `I18n.translate` text from `polish` gives one `MESSAGE_TRANSLATION_MISSING` warning naming it, and the app still boots and shows the source; removing `Ui.polishTranslations` names `Ui.Translations` and every key it lacks.
4. Two catalogs translating one text into one language: the later wins, nothing refused.
5. A misspelt key, a placeholder outside a key's declared values and a `few` case in an `en` catalog are each refused by `telo check`; a declaration with keys named `lang` and `kind` checks clean.
6. `translations:` on a Library is refused by `telo check` and the kernel; a library outside the repo declaring its own `Telo.KeyedTranslations` and `x-telo-text-keys`, and one shipping `Telo.TextTranslations`, are translated through an app's block with no change to `ui`, `ui-react` or `i18n`.
7. A built-in error code's display message reaches a Polish caller in Polish with no catalog listed.
8. Nothing in the analyzer, the kernel or `http-server` names a translation kind or `Ui.Translations`; every key `ui` and `ui-react` draw exists in the declaration.

## Example after the change

The library side, in `ui`:

```yaml
kind: Telo.KeyedTranslations
metadata: { name: Translations }
keys:
  save: Save
  pagerRange:
    message: "{$first}–{$last} of {$total}"
    values: { first: integer, last: integer, total: integer }
  minLength:
    message: { plural: limit, cases: { one: "Must be at least {$limit} character", other: "Must be at least {$limit} characters" } }
    values: { limit: integer }
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

An application:

```yaml
kind: Telo.Application
metadata: { name: InvoicesApp, version: 1.0.0 }
lang: en
imports:
  Http: ../../../../http-server
  I18n: ../../../../i18n
  Ui: ../../../../ui
  UiReact: ../../../
ports:
  http: { env: PORT, default: 8130 }
translations:
  catalogs:
    - !ref englishOverrides
    - !ref Ui.polishTranslations
    - !ref polishOverrides
    - !ref polish
targets:
  - !ref server
---
kind: Ui.Translations
metadata: { name: englishOverrides }
lang: en
messages:
  save: Submit
---
kind: Ui.Translations
metadata: { name: polishOverrides }
lang: pl
messages:
  save: Zachowaj
---
kind: Telo.TextTranslations
metadata: { name: polish }
lang: pl
texts:
  - { text: Invoices, translation: Faktury }
  - { text: Number, translation: Numer }
  - { text: "Invoice {$number} is overdue", translation: "Faktura {$number} jest przeterminowana" }
---
kind: Telo.JsonSchema
metadata: { name: Invoice }
schema:
  type: object
  required: [number]
  properties:
    number: { type: string, title: Number, minLength: 3 }
---
kind: Ui.Form
metadata: { name: invoiceForm }
model: !ref Invoice
source: { basePath: /api/invoices }
---
kind: UiReact.App
metadata: { name: app }
title: Invoices
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Invoices
    children:
      - { type: composite, ref: !ref invoiceForm }
---
kind: Http.Api
metadata: { name: api }
routes:
  - request:
      path: /invoices/{number}/status
      method: GET
      schema:
        params:
          type: object
          required: [number]
          properties:
            number: { type: string }
    inputs:
      number: !cel "request.params.number"
      lang: !cel "request.lang"
    handler:
      kind: Run.Value
      inputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [number, lang]
          properties:
            number: { type: string }
            lang: { type: string, format: language-tag }
      value:
        message: !cel "I18n.translate('Invoice {$number} is overdue', inputs.lang, {'number': inputs.number})"
    returns:
      - status: 200
        content:
          application/json:
            schema:
              type: object
              required: [message]
              properties:
                message: { type: string }
            body: { message: !cel "result.message" }
---
kind: Http.Server
metadata: { name: server }
listen: { address: 127.0.0.1, port: !cel "ports.http" }
preferredLanguages: !cel "'lang' in request.query ? [request.query.lang] : []"
mounts:
  - path: /api
    mount: !ref api
  - path: /
    mount: !ref app
```

`GET /api/invoices/F-17/status` answers `{ "message": "Faktura F-17 jest przeterminowana" }` for `Accept-Language: pl` or `?lang=pl`, and `{ "message": "Invoice F-17 is overdue" }` otherwise; the form's button reads "Zachowaj" and "Submit" respectively.
