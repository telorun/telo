# Embedding module

Text → vector embeddings as a declarative Telo capability. Follows the `ai` /
`cache` idiom exactly: a core library declares an abstract **provider** (the
model contract) plus buffered **invocables** for the asymmetric retrieval pair
(`Query` / `Passage`); concrete vendor backends live in their own modules and
`extends` the abstract — the same way `cache-memory` / `cache-redis` back
`cache`.

Asymmetric retrieval models embed a search query differently from a stored
passage (Cohere `search_query`/`search_document`, Gemini
`RETRIEVAL_QUERY`/`RETRIEVAL_DOCUMENT`, Voyage `query`/`document`). Two kinds
make the intent structural and GUI-distinct: `Query` for the search side,
`Passage` for the indexed side. Symmetric models (OpenAI) ignore the
distinction — both kinds produce identical vectors on them. `Query`/`Passage`
is the canonical IR pairing (DPR, E5, BEIR); `Passage` is truthful about the
chunk-sized unit actually embedded in RAG.

## Packaging

- `modules/embedding/` — core lib: abstract `Model` + invocables `Query` /
  `Passage`.
- `modules/embedding-openai/` — first backend: `Model` extends `Embedding.Model`.

Every provider is its own dedicated module — the `cache-memory` /
`cache-redis` pattern. Each vendor backend ships independently and `extends`
`Embedding.Model`; the core lib never depends on a vendor.

## Layout

```
modules/embedding/
  telo.yaml                  # Library + Model abstract + Query/Passage definitions
  README.md
  docs/embedding.md
  nodejs/src/query.ts        # the Query invocable controller
  nodejs/src/passage.ts      # the Passage invocable controller
  tests/embed.yaml
  tests/__fixtures__/
modules/embedding-openai/
  telo.yaml                  # Library + Model definition (extends Embedding.Model)
  README.md
  nodejs/src/model.ts        # the provider controller
  tests/embed-openai.yaml
```

---

## Resource 1 — `Embedding.Model` (abstract)

The provider contract every backend implements. No schema, no controller — pure
contract, exactly like `Cache.Store` and `Ai.Model`.

### Definition (in `modules/embedding/telo.yaml`)

```yaml
kind: Telo.Abstract
metadata:
  name: Model
capability: Telo.Provider
```

### Usage

Never instantiated directly — it is the target of `extends:` (backends) and
`x-telo-ref: "std/embedding#Model"` (the `model` slot on `Query` / `Passage`).

---

## Resource 2 — `Embedding.Query` (invocable)

Embeds one or many **search queries**. Batch-first — a single string is the
one-element case. The controller passes the retrieval intent `query` to the
backend (mapped to the vendor's `search_query` / `RETRIEVAL_QUERY` parameter);
symmetric backends ignore it.

`Query` and `Passage` share an **identical** `inputType` / `outputType` /
`schema` — they differ only in `metadata.name`, the controller export, and the
intent the controller passes to the provider.

### Definition (in `modules/embedding/telo.yaml`)

```yaml
kind: Telo.Definition
metadata:
  name: Query
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/embedding@0.1.0?local_path=./nodejs#query
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [input]
    additionalProperties: false
    properties:
      input:
        description: A single query, or a batch of queries, to embed.
        oneOf:
          - type: string
          - type: array
            minItems: 1
            items: { type: string }
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [embeddings, dimensions, usage]
    additionalProperties: false
    properties:
      embeddings:
        description: One vector per input, in input order.
        type: array
        items: { type: array, items: { type: number } }
      dimensions:
        type: integer
        minimum: 1
      usage:
        type: object
        required: [promptTokens, totalTokens]
        additionalProperties: false
        properties:
          promptTokens: { type: integer, minimum: 0 }
          totalTokens: { type: integer, minimum: 0 }
schema:
  type: object
  required: [model]
  additionalProperties: false
  properties:
    model:
      title: Model
      description: Reference to any Embedding.Model implementation.
      x-telo-ref: "std/embedding#Model"
    options:
      title: Options
      description: Provider-specific per-call options.
      type: object
      additionalProperties: true
  examples:
    - model: !ref textEmbedding
```

### Usage

```yaml
kind: Embedding.Query
metadata:
  name: queryVector
model: !ref textEmbedding

---
# invoked on the retrieval side, before VectorStore.Match
- name: embedQuery
  invoke: !ref queryVector
  inputs:
    input: "What is Telo?"
# → steps.embedQuery.result.embeddings[0]  is the query vector
```

---

## Resource 3 — `Embedding.Passage` (invocable)

Embeds one or many **stored passages** (the chunks you index). Structurally
identical to `Query`; the controller passes the intent `passage` (mapped to the
vendor's `search_document` / `RETRIEVAL_DOCUMENT` parameter).

### Definition (in `modules/embedding/telo.yaml`)

```yaml
kind: Telo.Definition
metadata:
  name: Passage
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/embedding@0.1.0?local_path=./nodejs#passage
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [input]
    additionalProperties: false
    properties:
      input:
        description: A single passage, or a batch of passages, to embed.
        oneOf:
          - type: string
          - type: array
            minItems: 1
            items: { type: string }
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [embeddings, dimensions, usage]
    additionalProperties: false
    properties:
      embeddings:
        description: One vector per input, in input order.
        type: array
        items: { type: array, items: { type: number } }
      dimensions:
        type: integer
        minimum: 1
      usage:
        type: object
        required: [promptTokens, totalTokens]
        additionalProperties: false
        properties:
          promptTokens: { type: integer, minimum: 0 }
          totalTokens: { type: integer, minimum: 0 }
schema:
  type: object
  required: [model]
  additionalProperties: false
  properties:
    model:
      title: Model
      description: Reference to any Embedding.Model implementation.
      x-telo-ref: "std/embedding#Model"
    options:
      title: Options
      description: Provider-specific per-call options.
      type: object
      additionalProperties: true
  examples:
    - model: !ref textEmbedding
```

### Usage

```yaml
kind: Embedding.Passage
metadata:
  name: passageVector
model: !ref textEmbedding

---
# invoked on the indexing side, before VectorStore.Record
- name: embedPassage
  invoke: !ref passageVector
  inputs:
    input: !cel variables.document
# → steps.embedPassage.result.embeddings[0]  is the passage vector
```

---

## Resource 4 — `EmbeddingOpenai.Model` (provider, backend module)

Concrete OpenAI-backed embedding model. Lives in `embedding-openai`, `extends`
the core abstract. Schema mirrors `ai-openai`'s `OpenaiModel` (model id + api key
+ base url + options), plus `dimensions` since OpenAI v3 models support it.

### Definition (in `modules/embedding-openai/telo.yaml`)

```yaml
kind: Telo.Definition
metadata:
  name: Model
capability: Telo.Provider
extends: Embedding.Model
controllers:
  - pkg:npm/@telorun/embedding-openai@0.1.0?local_path=./nodejs#model
schema:
  type: object
  required: [model, apiKey]
  additionalProperties: false
  properties:
    model:
      title: Model ID
      description: OpenAI embedding model (e.g. text-embedding-3-small).
      type: string
    apiKey:
      title: API Key
      type: string
      x-telo-eval: compile
    baseUrl:
      title: Base URL
      type: string
      x-telo-eval: compile
    dimensions:
      title: Dimensions
      description: Output dimensionality (v3 models support truncation).
      type: integer
      minimum: 1
    options:
      title: Options
      type: object
      additionalProperties: true
  examples:
    - model: text-embedding-3-small
      apiKey: "${{ secrets.openaiApiKey }}"
      dimensions: 1536
```

### Usage

```yaml
kind: EmbeddingOpenai.Model
metadata:
  name: textEmbedding
model: text-embedding-3-small
apiKey: !cel secrets.openaiApiKey
dimensions: 1536
```

---

## Controller notes

- `embedding/nodejs/src/query.ts` / `passage.ts` — `Telo.Invocable`s. Each reads
  the resolved `model` provider, normalizes `input` to `string[]`, and calls
  `model.embed(texts, { intent, ...options })` with its fixed intent (`query` /
  `passage`), returning `{ embeddings, dimensions, usage }`. The two share a
  helper; only the intent constant differs. Errors from the provider propagate —
  never swallow.
- `embedding-openai/nodejs/src/model.ts` — `Telo.Provider`. `init()` constructs
  the OpenAI client from compiled `apiKey`/`baseUrl`; `provide()` returns an
  embed-capable handle the operations call. OpenAI is symmetric, so the `intent`
  argument is accepted and ignored. Dimension passthrough.

## Tests

- `embedding/tests/embed.yaml` — uses a tiny deterministic fake `Model`
  (fixture backend in `__fixtures__/`) so the core embed op is tested without a
  network call: assert vector length == declared dimensions, batch order
  preserved.
- `embedding-openai/tests/embed-openai.yaml` — gated on `OPENAI_API_KEY`;
  smoke-test a real call.

## Docs & release checklist

- `modules/embedding/docs/embedding.md` + `embedding-openai/docs/…`; wire both
  into `pages/docusaurus.config.ts` `include` and `pages/sidebars.ts`, add
  `sidebar_label` frontmatter.
- New npm controller packages → one changeset each.
- New modules → `changie new --project embedding` / `embedding-openai`; re-run
  `scripts/gen-changie-config.mjs`.
