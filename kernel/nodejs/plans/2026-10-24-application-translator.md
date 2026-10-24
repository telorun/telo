# One translator for the whole application, and automatic language negotiation

## Problem

**Translation is wired per resource.**
- `UiReact.App` carries its own `translator:` and a `lang:` expression that every author writes. The ui-showcase repeats `Self.chosenLanguage(…)` over the cookie and `Accept-Language` headers on every app.
- An HTTP server has no translator at all, so an error's `detail` can only be its source text.
- A library cannot see which translator its importer chose.

**Negotiation is hand-written CEL**, although the default language (the root `lang:`) and the available languages (the translator's catalogs) are already declared.

**`I18n.Translator` is a synchronous CEL function.** So a backend that reads files or calls a service cannot be a translator, and the Rust kernel can host none.

## Solution

**The translation contract:** a built-in abstract, `Telo.Translator`, capability `Telo.Invocable`, in the built-in vocabulary beside `Text`, `TextCatalog` and `TextRecord`.

- **Input:** `{ lang, texts }`, where `lang` is one language tag and `texts` is a list of `TextRecord`.
- **Output:** `{ languages, messages }`.
  - `languages`: the tags this translator answers in.
  - `messages`: one `{ message, lang }` per input record, in input order. `message` is a `Message`, never a formatted string; `lang` is the language actually reached, the record's own when nothing translates it.
- **Batching:** a caller sends every text one response needs in one call.
- **Reading the languages:**
  - The kernel reads `languages` with an empty `texts` once the translator has initialized, and again after a reconcile rebuilds it.
  - The set is stable for an instance's lifetime.
  - A `messages` list whose length differs from `texts` is `ERR_OUTPUT_INVALID`.

**The application key:** `translator:` on the root Application, a `!ref` or an inline declaration of a `Telo.Translator`.

- **Application-only.** A Library declaring it is refused like `tracing:`; anything not a translator is `REFERENCE_KIND_MISMATCH`.
- **Initialized first.** The referenced translator and its dependencies initialize before every other root resource.
- **Not an error when unused.** A translator no `translator:` names is not an error.

**What controllers get:**

- **Two services on every resource context.**
  - lookup: a language and records in, messages out;
  - the application's languages: the translator's `languages` plus the root `lang:`, which is the default.
- **Over the controller protocol:** one batched lookup request whose answer carries `languages`.
- **Without `translator:`:** every record answers with its own message in its own language, and the available set is the root `lang:` alone, or `und`.
- **A failed lookup fails the operation that asked for it** and is reported. It never falls back to the source text silently.
- **Library texts too.** Every module's texts, built-in error texts and `Ui.words` included, are looked up through the application's translator by text identity and context.

**Negotiation:**

- **Matching:** a weighted preference list matched against the available set, falling back to the root `lang:`. It lives in `@telorun/message-format`, with conformance vectors its Rust twin runs.
- **`request.lang`:** `Http.Server` reads `Accept-Language` on every request and exposes the result as `request.lang`. It is readable:
  - in every request-scoped CEL context: route `inputs`, `returns` and `catches`, router and server `catches`, guards and `notFoundHandler`;
  - by every mount, through the published mount contract in `@telorun/http-dispatch`.
- **Override:** `Http.Server.languagePreference` is an optional per-request expression yielding a tag or `null`. It is tried before `Accept-Language` and matched the same way. The author says where a preference comes from (a cookie, a path, a profile), never how to negotiate.
- **`Content-Language`** names the languages the texts the server rendered actually reached, starting with a problem's `detail`.
- **`Vary`** names `Accept-Language` plus every header `languagePreference` reads, on every response whose rendering read the language. That is known statically.

**ui-react:**

- `UiReact.App.translator` and `UiReact.App.lang` are removed and refused by its schema. The app uses the application translator and `request.lang`, keeping one set of documents per reached language.
- The renderer sends `Accept-Language: <document language>` on every fetch, so APIs answer in the page's language.
- The ui-showcase is rewritten to one `languagePreference` reading the `showcase-lang` cookie.

**i18n:**

- **`I18n.Catalog`:** unchanged.
- **`I18n.Translator`:** becomes `capability: Telo.Invocable`, `extends: Telo.Translator`. Its `catalogs` keep `x-telo-text-catalog-set: true`, so every catalog check still holds.
- **`I18n.Translate`:** new. It is a `Telo.Callable` with `Self.t`'s signature unchanged and a `translator` slot naming an `I18n.Translator`, read as data. Call sites do not change.
- **`I18n.Negotiator`:** keeps `translator` and `default` and calls the shared matcher.

**Rust kernel:** it refuses `translator:` with `ERR_UNSUPPORTED_MANIFEST_FEATURE` until it serves the lookup service and the protocol request. It can host a translator implementation, since it hosts invocables.

**Migrations:**

- **`i18n-translate-split`** rewrites each `I18n.Translator` document to `I18n.Translate`, with its `catalogs` moved into an inline `translator: { kind: I18n.Translator, catalogs }`. The migration format gains the kind-rename and key-nesting operations this needs.
- **No migration for `UiReact.App`.** Its `translator:` / `lang:` move to another document, which a per-document migration cannot express. In-repo manifests are rewritten by hand, and the ui-react docs state the move.

**Bookkeeping:**

- `requires:` floors on i18n, http-server, ui-react and every application writing `translator:`, each verified by running the previous CLI.
- `telo release add` fragments per module and changesets for the telo version line.
- Docs: the i18n docs, `docs/extend/text-records.md`, the root `CLAUDE.md` (Application keys, built-in vocabulary), the controller protocol spec, the primer, the hub UI guide and the benefits ledger ("responses in the caller's language, with one translator for the whole application").

## Decisions

- **The contract is an abstract over `Telo.Invocable`.**
  - `Telo.Callable` is synchronous with no I/O, and the Rust kernel hosts none.
  - `Telo.Provider` cannot take arguments.
  - A new roster capability names no new lifecycle.
- **Lookup, not formatting.** ui-react ships the chosen Message to the browser, which formats it with row values.
- **One reference at the root.** A per-resource `translator:` repeats one application-wide fact on every text-showing kind, and libraries cannot see it.
- **`translator:`, not a `translation:` block.** The key holds one reference, and nothing else belongs beside it.
- **Translations stay as catalogs in i18n.** Built-in catalogs would remove the pluggable backend.
- **Negotiation is built into the transport.** The kernel never sees a request; rewriting the match at every site is what this removes.
- **One optional `languagePreference` expression.** Closed cookie / query / header source kinds cannot express a profile or path choice.
- **The language is an explicit `request.lang`, never ambient.** Static analysis must see every input.

## Example after the change

```yaml
kind: Telo.Application
metadata: { name: Orders }
lang: en
translator: !ref t
imports:
  Http: oci://ghcr.io/telorun/http-server@…
  I18n: oci://ghcr.io/telorun/i18n@…
ports:
  http: { env: PORT, protocol: tcp, default: 8080 }
targets:
  - !ref server
---
kind: I18n.Translator
metadata: { name: t }
catalogs:
  - kind: I18n.Catalog
    lang: pl
    texts:
      - { text: "Order {$id} does not exist.", translation: "Zamówienie {$id} nie istnieje." }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /
    mount: !ref ordersApi
```

With `Accept-Language: pl-PL, en;q=0.5`, an `ORDER_NOT_FOUND` problem carries `"detail":"Zamówienie 42 nie istnieje."`, `Content-Language: pl` and `Vary: Accept-Language`, with no language expression written anywhere.

## Verify

- **One translator everywhere:** with only a root `translator: !ref t`, `Ui.words`, a problem's `detail` and a `Self.t` call all answer in Polish.
- **Negotiation:** `Accept-Language: pl-PL, en;q=0.5` gives `request.lang == "pl"` with no key written. A `showcase-lang=de` cookie wins when `languagePreference` reads it, and `Vary` names exactly the headers read.
- **Without a translator:** `request.lang` is always the root `lang:`.
- **Refusals:** a Library declaring `translator:` is refused by `telo check`, and a duplicate catalog entry under the referenced translator is refused statically.
- **Contract enforcement:** a non-catalog translator answering the wrong number of messages is `ERR_OUTPUT_INVALID`. A failing translator fails the response and is logged.
- **Node and Rust agree:** both message-format matchers answer the shared vectors alike.
- **Migration:** `telo migrate` turns an old `I18n.Translator` document into `I18n.Translate` plus an inline translator, and its `Self.t` calls keep answering the same.
