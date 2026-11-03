---
status: in-progress
priority: high
depends-on: [2026-11-02-application-translations.md, 2026-11-02-keyed-translations.md]
packages: [modules/ui]
tracking: feat/application-translations
---

# `ui` texts by key

Third of four plans. It builds on application translations and keyed translations.

## Problem

`ui`'s own texts — "Save", "Delete this row?", the pager's "1–25 of 340", a validation message per schema keyword — are the `Ui.Words` kind: ~90 ids, each restated in its `required`, its `properties`, the wire's word enum and the instance. There is one English instance, `Ui.words`.

- Every UI app writes `words: !ref Ui.words`.
- A word is translated by its English text, so changing "Save" also rewrites every "Save" the author wrote.
- Every app translates `ui`'s words itself. The showcase carries all ~90 in each of its 14 language files.

## Solution

**`ui` declares its texts by key.** `Ui.Words` and `Ui.words` are replaced by a `Telo.KeyedTranslations` document named `Translations`, which declares the kind `Ui.Translations`. Each id becomes a key, with its English wording as the source and `values` for every placeholder.

**`ui` ships the translations.** It ships and exports one `Ui.Translations` per language — `Ui.germanTranslations`, `Ui.polishTranslations`, … — for the 14 languages the showcase translates today, moved out of the showcase. An application lists the ones it serves in its `translations:` block, and may override any key with its own `Ui.Translations` listed after them.

**What gets drawn.**

- `ui`'s kinds that fill texts declare `x-telo-text-keys: [Self.Translations]`, and `UiReact.App` declares `[Ui.Translations]`.
- On the wire, a keyed text is `{ set: <canonical kind>, key }`.
- The renderer receives one message map per set and language, so it draws any library's keyed texts without naming `Ui.Translations`.
- `UiReact.App` loses `words:`.

## Decisions

- **No load-time migration**: every in-repo manifest writing `words:` is rewritten in the same change.

## Scope

- **`ui`:** the `Translations` declaration replacing `Ui.Words` / `Ui.words`, the 14 shipped translations, `x-telo-text-keys`, and the `{ set, key }` wire shape.
- **`ui-react`:** per-set message maps on the wire, the renderer drawing `{ set, key }` texts, and `words:` removed.
- **`requires: telo:` floors** on `ui` and `ui-react`, each verified by running the previous CLI (`run`, since both read the extended seam).
- **Rewritten manifests:** every manifest writing `words:`. The showcase lists the shipped `Ui.*Translations` and drops its copies of `ui`'s words.
- **Docs:** `ui/docs/texts.md`, the `ui-react` docs, the authoring-agent primer, the hub's `build-ui` guide, and a benefits-ledger entry: built-in UI texts arrive translated into 14 languages.
- **Release bookkeeping:** a fragment per module.

## Verify

1. An English-only app with no `translations:` and no `words:` shows "Save".
2. In the example below:
   - `Accept-Language: pl` shows "Zachowaj" on the form's button.
   - `de` shows "Submit".
   - A "Save" the author wrote is untouched in both.
   - Without `polishOverrides`, `pl` shows "Zapisz".
3. The showcase renders its 14 languages as before, with no copy of `ui`'s words in its own files.
4. Every key `ui` and `ui-react` draw exists in the declaration, and nothing in `ui-react`'s renderer names `Ui.Translations`.

## Example after the change

```yaml
kind: Telo.Application
metadata: { name: InvoicesApp, version: 1.0.0 }
lang: en
imports:
  Http: ../../../../http-server
  Ui: ../../../../ui
  UiReact: ../../../
translations:
  catalogs:
    - !ref englishOverrides
    - !ref Ui.polishTranslations
    - !ref polishOverrides
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
kind: Telo.JsonSchema
metadata: { name: Invoice }
schema:
  type: object
  required: [number]
  properties:
    number: { type: string, title: Number, minLength: 3 }
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
      - type: composite
        ref: { kind: Ui.Form, model: !ref Invoice, source: { basePath: /api/invoices } }
---
kind: Http.Server
metadata: { name: server }
listen: { address: 127.0.0.1, port: 8130 }
mounts:
  - { path: /, mount: !ref app }
```
