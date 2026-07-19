# @telorun/embedding-openai

## 0.4.0

### Minor Changes

- 2395a4a: Make network failures actionable instead of `fetch failed`.

  `fetch` rejects with an opaque `TypeError: fetch failed` for DNS, connection
  refusal, and TLS alike; the real cause (`ENOTFOUND`, `ECONNREFUSED`, …) sits on
  `error.cause`, which nothing in the repo read. A misconfigured host surfaced as
  `INTERNAL_ERROR: fetch failed` with nothing to act on — no host, no reason, no
  indication of which manifest field was wrong.

  `fetchOrThrow` in `@telorun/sdk` wraps a transport failure as an `InvokeError`
  with code `ERR_NETWORK_UNREACHABLE`, carrying structured `data` — `operation`,
  `url`, `host`, `port`, `cause`, the underlying `detail`, and the `resource` +
  `setting` to change — plus a default message composed from them. A non-OK
  response is returned untouched — a status code is a reply the caller interprets,
  often from the provider's own error body — so it drops into existing call sites
  without changing status handling. Cancellation is re-thrown as-is.

  Every part is structured, including the actionable one: a call site passes
  `resource` (the instance's `metadata.name`) and `setting` (`baseUrl`) as bare
  identifiers, and the sentence is composed in one place. Prose at the call site
  would be exactly what another language's SDK has to retype and keep in sync,
  whereas `cause: "ENOTFOUND"` and `setting: "baseUrl"` are the same symbols
  everywhere — so a kernel-side renderer can later format from `data` without any
  SDK changing.

  Wrapping never loses what was thrown: the original error is preserved as
  `cause` (`InvokeError` gained an optional `{ cause }`), its message is kept in
  `data.detail`, and for a code the mapping does not recognise that message is
  appended to the rendered text — so an unmapped code reads as strictly more than
  the raw `fetch failed` it replaces, never less.

  Also fixes a live misclassification in `Http.Request`: `mapNetworkError`
  selected its error kind by substring-matching the message, but the message is
  always the literal `"fetch failed"`, so `enotfound`/`ssl` never matched and every
  network failure — DNS and TLS included — was reported as `CONNECTION_REFUSED`.
  It now classifies on the cause chain's code, via the exported `networkCauseCode`.
  `Mcp.Client` had the same opaque-message problem in its transport error and is
  fixed the same way.

### Patch Changes

- @telorun/embedding@0.3.0

## 0.3.0

### Minor Changes

- bd4f3ac: Add `queryPrompt` / `passagePrompt` to the `Embedding.Model` abstract.

  Prompt-tuned retrieval checkpoints (embeddinggemma, E5, BGE) expect each text
  wrapped in a fixed instruction that differs by retrieval intent. Feeding them
  raw text does not fail — it collapses the similarity spread, so ranking
  degenerates into noise. The templates are declared on the model, so the query
  and passage sides cannot drift apart, and backends apply them through the
  shared `applyEmbeddingPrompt` / `resolveEmbeddingPrompts` helpers. A template
  missing the `{text}` placeholder is rejected at boot.

  The kernel now stamps the inheritance-resolved author schema onto a definition
  that `extends` another kind, reusing the analyzer's `effectiveAuthorSchema`.
  Previously the analyzer accepted a field inherited from an `extends` parent
  while the kernel — validating against the child's own schema only — rejected
  the same resource at `create()`.

### Patch Changes

- Updated dependencies [bd4f3ac]
  - @telorun/embedding@0.3.0

## 0.2.0

### Minor Changes

- df6a1b0: Add the `embedding` module — the `Embedding.Model` abstract plus the `Embedding.Query` / `Embedding.Passage` invocables that turn text into vectors — and `embedding-openai`, an OpenAI-compatible backend (`EmbeddingOpenai.Model`) speaking the `/embeddings` HTTP API directly.

  `Query` and `Passage` are the two sides of the asymmetric retrieval pair: each passes a fixed intent (`query` / `passage`) to the backend, mapped to the vendor's input-type parameter. Symmetric backends (OpenAI) accept and ignore it. Backends implement the `EmbeddingModel` contract from `@telorun/embedding` and extend `Embedding.Model`, mirroring the `cache` / `cache-memory` split.

### Patch Changes

- Updated dependencies [df6a1b0]
  - @telorun/embedding@0.2.0
