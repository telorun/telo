---
status: done
priority: high
depends-on: []
packages: [analyzer, kernel, sdk, modules/i18n, modules/http-server]
tracking: feat/application-translations
---

# Application translations and request language

First of four plans: application translations → keyed translations → `ui` texts by key → missing-translation reporting.

## Problem

- Every UI app writes `translator: !ref <I18n.Translator>`, an `I18n.Negotiator` and a `lang:` expression to pick a language.
- An API translating with `Self.t` lists the same catalogs again on its own translator, under a different rule (a translator refuses a text translated twice; nothing else layers), and negotiates the language in author-written CEL.
- Translations by text are a kind of the `i18n` module, so a library shipping its own must import `i18n` to describe them.

## Solution

**Two built-in kinds.** `Telo.Translations` is an abstract that declares only `lang` (a language tag, required). `Telo.TextTranslations` extends it with `texts:`, a list of `{ text, context?, translation }` matched by source text and context — the shape `I18n.Catalog` has today. `I18n.Catalog` is deprecated with `replacedBy: Telo.TextTranslations` and keeps working.

**The application declares its translations once.** `translations: { catalogs: [...] }` is an Application-only block. Each entry is a `!ref` or an inline `Telo.Translations` resource, resolved at load before any resource exists, like `logging:`. A `Telo.Library` that writes it is refused, as `tracing:` is. Each `App.Instance` child has its own.

**Served languages** are the Application's `lang:` (the fallback; `und` when absent) plus every listed catalog's `lang`.

**Layering is the one rule.** Per language, entries apply in `catalogs` order and a later one wins, per text and context. A text translated twice within one catalog stays `MESSAGE_ENTRY_DUPLICATE`; across catalogs it is an override. `x-telo-text-catalog-set` and `TEXT_CATALOG_SET_INVALID` leave the vocabulary. A library's texts are translated by the importing application's set, the same for an isolated or a shared import.

**The transport chooses the language.** The kernel offers one negotiation: an ordered preference list matched against the served languages by RFC 4647 lookup (`pl-PL` finds `pl`), landing on the fallback. Every inbound transport exposes the result as `lang` on its inbound context — a language tag, always present.

**HTTP.** The request language is `request.lang`, present in every request context the http-server kinds declare (route `inputs` / `returns` / `catches`, router and server `catches`, guards), negotiated once per request before the guard.

- `Http.Server.preferredLanguages` (optional) is a CEL expression over `request` (no `lang`) returning tags in preference order — a cookie, a path prefix, a query parameter.
- Those tags are tried first, then `Accept-Language` by quality, then the fallback. Malformed or unserved entries are skipped, never refused.
- With more than one served language, a response whose production read the language carries `Content-Language` and `Vary: Accept-Language`. `Vary` also lists every header `preferredLanguages` reads, or is `Vary: *` for a computed header name.
- A problem's `detail` is formatted in `request.lang`.

**The controller seam.** The kernel hands a controller the served languages, the fallback, the negotiation and by-text lookup over the layered set, through one seam. The seam is also a message of the controller protocol, in a new generation.

**Translating outside the UI.** `I18n.Negotiator` is removed. `I18n.Translator` loses `catalogs`, stops being exported, and backs one exported instance, **`translate`**, over the application's set: `I18n.translate('Invoice {$number} is overdue', request.lang, {'number': inputs.number})`. The `text` stays a literal `Text`, checked and attributed to the calling module. `lang` stays an explicit argument, and the function stays deterministic.

**`UiReact.App`** loses `catalogs:`, `lang:` and `translator:`. It reads `request.lang`, keeps one copy of each document per served language, and translates its texts (`Ui.Words` included, still by English text) through the application's set. The showcase's 14 language files become `Telo.TextTranslations` listed in its `translations:` block.

## Decisions

- **The set is the application's, the choice the transport's.** Django, ASP.NET Core, Rails, Next.js and Spring all split it this way. Rejected:
  - `languages:` on `Http.Server`: every server and transport restates the list, and it can disagree with the catalogs.
  - `catalogs:` on the App plus a separate translator: the set is listed twice under two rules.
  - One built-in translations resource each consumer references: a slot on every consumer, and two sets become possible.

  One application serves one language set on all its surfaces.
- **Overrides are layers in `translations.catalogs` order** — the Django `LOCALE_PATHS` / Helm values model. Rejected: CEL `merge()`, because a computed set is unchecked. An accidental repeat across catalogs silently wins; the editor marks the shadowed entry.
- **The translation kinds and the block are built in**, so a library depends on nothing to ship translations, and the analyzer never reads an `i18n` kind name.
- **The language is an explicit argument, never ambient.** No per-thread state exists in the step engine, in durable replay or in another kernel, and a deterministic function must not read hidden input.
- **`translate` stays a module function**, not a core CEL function. The core catalog holds no host vocabulary and could not check a literal `Text` argument.
- **No load-time migration**: in-repo manifests are rewritten in the same change.
- **The Rust kernel refuses `translations:` and `Telo.TextTranslations`** with `ERR_UNSUPPORTED_MANIFEST_FEATURE` until it reads them.

## Scope

- **Built-in vocabulary:**
  - `Telo.Translations` and `Telo.TextTranslations`.
  - The Application `translations:` block, refused on a Library.
  - Removal of `x-telo-text-catalog-set`.
  - Both analyzers' readers, and the Node kernel's loading, negotiation, seam and controller-protocol message.
  - Rows in the check/run agreement suite for `translations:` on a Library.
- **`http-server`:** `preferredLanguages`, `request.lang` in every request context, `Content-Language` / `Vary`, and the problem `detail` in `request.lang`.
- **`i18n`:** `Negotiator` removed, `Translator` behind the exported `translate`, and `I18n.Catalog` deprecated.
- **`ui-react`:** `request.lang`, per-language documents, and `catalogs` / `lang` / `translator` removed.
- **`requires: telo:` floors** on `ui-react`, `i18n` and `http-server`, each verified by running the previous CLI (`run` for the two that read the new seam).
- **Rewritten manifests:** every manifest writing a UI `translator:` / `lang:`, a negotiator or `I18n.Catalog`. The showcase moves to `translations:`.
- **Docs:**
  - The `ui-react`, `i18n` and `http-server` docs.
  - `docs/extend/text-records.md`, the analyzer guide, and the root `CLAUDE.md` Application and Text bullets.
  - The authoring-agent primer and the hub's `build-ui` guide.
  - A benefits-ledger entry: the request language is chosen for you, with `Content-Language` / `Vary` set.
- **Release bookkeeping:** a changeset for the telo version line, and a fragment per module.

## Verify

1. An English-only app with no `translations:` passes `telo check` clean, shows "Save", and its responses carry no `Content-Language` / `Vary`.
2. In the example below, `Accept-Language: pl` answers the API in Polish with `Content-Language: pl` and `Vary: Accept-Language`, and the form shows Polish words. `?lang=pl` does the same, and `Vary` adds nothing for the query. `de` answers English. Nothing lists the catalogs twice.
3. Two catalogs translating one text into one language: the later one wins, and nothing is refused. The same text twice in one catalog is `MESSAGE_ENTRY_DUPLICATE`.
4. `translations:` on a Library is refused by `telo check` and by the kernel. The Rust kernel refuses `translations:` and `Telo.TextTranslations`.
5. A library outside the repo shipping `Telo.TextTranslations` is translated through an app's block, with no change to `i18n` or `ui-react`.
6. An existing `I18n.Catalog` still works and reports `DEPRECATED_KIND`.
7. Nothing in the analyzer, the kernel or `http-server` names an `i18n` kind.

## Example after the change

```yaml
kind: Telo.Application
metadata: { name: InvoicesApp, version: 1.0.0 }
lang: en
imports:
  Http: ../../../../http-server
  I18n: ../../../../i18n
translations:
  catalogs:
    - kind: Telo.TextTranslations
      lang: pl
      texts:
        - { text: "Invoice {$number} is overdue", translation: "Faktura {$number} jest przeterminowana" }
targets:
  - !ref server
---
kind: Http.Api
metadata: { name: api }
routes:
  - request: { path: "/invoices/{number}/status", method: GET }
    inputs:
      number: !cel "request.params.number"
      lang: !cel "request.lang"
    handler:
      kind: Run.Value
      value:
        message: !cel "I18n.translate('Invoice {$number} is overdue', inputs.lang, {'number': inputs.number})"
    returns:
      - status: 200
        content:
          application/json:
            body: { message: !cel "result.message" }
---
kind: Http.Server
metadata: { name: server }
listen: { address: 127.0.0.1, port: 8130 }
preferredLanguages: !cel "'lang' in request.query ? [request.query.lang] : []"
mounts:
  - { path: /api, mount: !ref api }
```
