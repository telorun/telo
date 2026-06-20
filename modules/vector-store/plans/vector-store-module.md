# Vector store module

Vector indexing + similarity search as a declarative Telo capability. Mirrors
`cache` exactly: a core library declares an abstract **provider** (the index
contract) plus buffered **invocables** for each operation; concrete backends
live in their own modules and `extends` the abstract — `vector-store-memory` is
the first, the direct analogue of `cache-memory`.

## Packaging

- `modules/vector-store/` — core lib: abstract `Store` + `Record` / `Match` /
  `Removal`.
- `modules/vector-store-memory/` — in-memory backend: `Store` extends
  `VectorStore.Store`. Dedicated module, per the `cache-memory` precedent.

Later backends (own modules, no manifest churn for consumers):
`vector-store-pgvector`, `vector-store-qdrant`.

## Operation naming

`Record` (write), `Match` (query), `Removal` (delete) — declarative nouns,
matching `cache`'s own all-noun invocables (`Lookup`/`Entry`/`View`).

## Layout

```
modules/vector-store/
  telo.yaml                  # Library + Store abstract + Record/Match/Removal
  README.md
  docs/vector-store.md
  nodejs/src/record.ts
  nodejs/src/match.ts
  nodejs/src/removal.ts
  tests/roundtrip.yaml
modules/vector-store-memory/
  telo.yaml                  # Library + Store definition (extends VectorStore.Store)
  README.md
  nodejs/src/store.ts
  tests/memory-store.yaml
```

---

## Resource 1 — `VectorStore.Store` (abstract)

The index contract. No schema, no controller — backend config (metric,
dimensions) lives on the concrete backend, exactly as `Cache.Store` carries
nothing and `cache-memory`'s `Store` carries `maxEntries`.

### Definition (in `modules/vector-store/telo.yaml`)

```yaml
kind: Telo.Abstract
metadata:
  name: Store
capability: Telo.Provider
```

### Usage

Target of `extends:` (backends) and `x-telo-ref: "std/vector-store#Store"` (the
`store` slot on every operation).

---

## Resource 2 — `VectorStore.Record` (invocable)

Upsert vectors with ids + metadata. Batch-first; same kind handles one or many.

### Definition (in `modules/vector-store/telo.yaml`)

```yaml
kind: Telo.Definition
metadata:
  name: Record
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/vector-store@0.1.0?local_path=./nodejs#record
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [items]
    additionalProperties: false
    properties:
      items:
        type: array
        minItems: 1
        items:
          type: object
          required: [id, vector]
          additionalProperties: false
          properties:
            id: { type: string }
            vector: { type: array, items: { type: number } }
            metadata: { type: object, additionalProperties: true }
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [ids]
    additionalProperties: false
    properties:
      ids:
        description: Ids written, in input order.
        type: array
        items: { type: string }
schema:
  type: object
  required: [store]
  additionalProperties: false
  properties:
    store:
      title: Store
      description: Reference to the backing vector store.
      x-telo-ref: "std/vector-store#Store"
  examples:
    - store: !ref knowledgeBase
```

### Usage

```yaml
kind: VectorStore.Record
metadata:
  name: record
store: !ref knowledgeBase

---
- name: store
  invoke: !ref record
  inputs:
    items:
      - id: !cel variables.docId
        vector: !cel steps.embed.result.embeddings[0]
        metadata: { text: !cel variables.document }
```

---

## Resource 3 — `VectorStore.Match` (invocable)

Nearest-neighbour query. Vector-only (recommended): caller embeds the query text
first with `Embedding.Query`, keeping this op single-responsibility and free of
an embedder dependency.

### Definition (in `modules/vector-store/telo.yaml`)

```yaml
kind: Telo.Definition
metadata:
  name: Match
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/vector-store@0.1.0?local_path=./nodejs#match
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [vector]
    additionalProperties: false
    properties:
      vector: { type: array, items: { type: number } }
      filter:
        description: Backend-evaluated metadata filter.
        type: object
        additionalProperties: true
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [matches]
    additionalProperties: false
    properties:
      matches:
        type: array
        items:
          type: object
          required: [id, score]
          additionalProperties: false
          properties:
            id: { type: string }
            score: { type: number }
            metadata: { type: object, additionalProperties: true }
            vector: { type: array, items: { type: number } }
schema:
  type: object
  required: [store]
  additionalProperties: false
  properties:
    store:
      title: Store
      x-telo-ref: "std/vector-store#Store"
    topK:
      title: Top K
      description: Maximum matches to return.
      type: integer
      minimum: 1
      default: 10
    includeVectors:
      title: Include vectors
      description: Return the stored vector on each match.
      type: boolean
      default: false
  examples:
    - store: !ref knowledgeBase
      topK: 5
```

### Usage

```yaml
kind: VectorStore.Match
metadata:
  name: match
store: !ref knowledgeBase
topK: 5

---
- name: search
  invoke: !ref match
  inputs:
    vector: !cel steps.embedQuery.result.embeddings[0]
# → steps.search.result.matches[0].id / .score / .metadata
```

---

## Resource 4 — `VectorStore.Removal` (invocable)

Delete by id list or metadata filter.

### Definition (in `modules/vector-store/telo.yaml`)

```yaml
kind: Telo.Definition
metadata:
  name: Removal
capability: Telo.Invocable
controllers:
  - pkg:npm/@telorun/vector-store@0.1.0?local_path=./nodejs#removal
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    additionalProperties: false
    minProperties: 1
    properties:
      ids:
        type: array
        minItems: 1
        items: { type: string }
      filter:
        type: object
        additionalProperties: true
outputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [removed]
    additionalProperties: false
    properties:
      removed:
        description: Count of entries deleted.
        type: integer
        minimum: 0
schema:
  type: object
  required: [store]
  additionalProperties: false
  properties:
    store:
      title: Store
      x-telo-ref: "std/vector-store#Store"
  examples:
    - store: !ref knowledgeBase
```

### Usage

```yaml
kind: VectorStore.Removal
metadata:
  name: removal
store: !ref knowledgeBase

---
- name: drop
  invoke: !ref removal
  inputs:
    ids: [doc-1, doc-2]
# → steps.drop.result.removed
```

---

## Resource 5 — `VectorStoreMemory.Store` (provider, backend module)

In-memory cosine/dot/euclidean index for dev and tests. `extends` the core
abstract; carries the backend-specific config (metric, dimensions, capacity) —
analogue of `cache-memory`'s `Store` carrying `maxEntries`.

### Definition (in `modules/vector-store-memory/telo.yaml`)

```yaml
kind: Telo.Definition
metadata:
  name: Store
capability: Telo.Provider
extends: VectorStore.Store
controllers:
  - pkg:npm/@telorun/vector-store-memory@0.1.0?local_path=./nodejs#store
schema:
  type: object
  additionalProperties: false
  properties:
    metric:
      title: Metric
      type: string
      enum: [cosine, dot, euclidean]
      default: cosine
    dimensions:
      title: Dimensions
      description: Expected vector length; inserts of other lengths are rejected.
      type: integer
      minimum: 1
    maxEntries:
      title: Max Entries
      description: When exceeded, the oldest-written entry is evicted (FIFO).
      type: integer
      minimum: 1
  examples:
    - metric: cosine
      dimensions: 1536
```

### Usage

```yaml
kind: VectorStoreMemory.Store
metadata:
  name: knowledgeBase
metric: cosine
dimensions: 1536
```

---

## End-to-end manifest (index then retrieve)

```yaml
kind: Telo.Application
metadata:
  name: rag-index
  version: 0.1.0
imports:
  Embedding: std/embedding@0.1.0
  EmbeddingOpenai: std/embedding-openai@0.1.0
  VectorStore: std/vector-store@0.1.0
  VectorStoreMemory: std/vector-store-memory@0.1.0
  Run: std/run@0.9.0
secrets:
  openaiApiKey: { env: OPENAI_API_KEY, type: string }
variables:
  document: { env: DOCUMENT_TEXT, type: string, default: "Telo is a declarative runtime." }
  docId:    { env: DOCUMENT_ID,   type: string, default: doc-1 }

---
kind: EmbeddingOpenai.Model
metadata: { name: textEmbedding }
model: text-embedding-3-small
apiKey: !cel secrets.openaiApiKey
dimensions: 1536

---
kind: Embedding.Passage
metadata: { name: passageVector }
model: !ref textEmbedding

---
kind: Embedding.Query
metadata: { name: queryVector }
model: !ref textEmbedding

---
kind: VectorStoreMemory.Store
metadata: { name: knowledgeBase }
metric: cosine
dimensions: 1536

---
kind: VectorStore.Record
metadata: { name: record }
store: !ref knowledgeBase

---
kind: VectorStore.Match
metadata: { name: match }
store: !ref knowledgeBase
topK: 5

---
kind: Run.Sequence
metadata: { name: indexDocument }
steps:
  - name: embedPassage
    invoke: !ref passageVector
    inputs: { input: !cel variables.document }
  - name: store
    invoke: !ref record
    inputs:
      items:
        - id: !cel variables.docId
          vector: !cel steps.embedPassage.result.embeddings[0]
          metadata: { text: !cel variables.document }
  - name: embedQuery
    invoke: !ref queryVector
    inputs: { input: "What is Telo?" }
  - name: search
    invoke: !ref match
    inputs: { vector: !cel steps.embedQuery.result.embeddings[0] }

---
targets:
  - !ref indexDocument
```

---

## Controller notes

- `record.ts` / `match.ts` / `removal.ts` — `Telo.Invocable`s; each resolves the
  `store` provider and calls its `upsert` / `query` / `delete`. Reject vectors
  whose length != the store's declared `dimensions`. Errors propagate.
- `vector-store-memory/nodejs/src/store.ts` — `Telo.Provider`; `provide()`
  returns a handle backed by a `Map<id, {vector, metadata}>` with the configured
  metric and FIFO eviction.

## Tests

- `vector-store/tests/roundtrip.yaml` — backed by `vector-store-memory`:
  Record 3 vectors → Match a near-duplicate → assert top hit id + score
  ordering; Removal by id → Match → assert it's gone.
- `vector-store-memory/tests/memory-store.yaml` — metric math + dimension
  rejection + eviction.

## Docs & release checklist

- `docs/vector-store.md` + `vector-store-memory/docs/…`; wire into
  `pages/docusaurus.config.ts` `include`, `pages/sidebars.ts`, `sidebar_label`.
- New npm controller packages → one changeset each.
- New modules → `changie new --project vector-store` /
  `vector-store-memory`; re-run `scripts/gen-changie-config.mjs`.
