# Web Search

The engine-neutral contract for web search: send a query with optional language,
country and recency hints, and get back ranked results with title, URL, snippet
and publication date, plus a cursor for the next slice.

## Why use this

- **Accept any engine.** A library, template or blueprint that searches the web
  types its slot against `WebSearch.Engine` and imports only this module. The
  application decides which engine runs, and swapping it is swapping one
  resource.
- **One vocabulary for queries and results.** The query and the results are the
  exported shapes `WebSearch.Query` and `WebSearch.Results`, so a misspelled
  argument or result field is a `telo check` error at the call site.
- **Paging that works the same everywhere.** Every engine returns an opaque
  `nextCursor` while more results are reachable; a caller loops until it is
  absent, whatever the engine's own paging model.
- **One set of failure codes.** Bad input, denied access, rate limiting, an
  exhausted quota and an engine failure are the same codes for every engine, so a
  caller's `catches:` and retry policy do not depend on the engine.

## Contents

| Name | Is |
| --- | --- |
| `WebSearch.Engine` | Abstract: search the web for one query. |
| `WebSearch.Query` | The input shape: `query`, `count`, `cursor`, `language`, `country`, `freshness`. |
| `WebSearch.Results` | The output shape: `results[]` of `{ title, url, snippet, publishedAt? }` and `nextCursor?`. |
| `WebSearch.sealCursor` | Function: build the cursor an engine returns. |
| `WebSearch.openCursor` | Function: check and read the cursor a call carries. |
| `WebSearch.resolveHint` | Function: map a language or country hint through an engine's table. |
| `WebSearch.freshnessStart` | Function: the start of a recency window. |
| `WebSearch.windowRequest` | Function: how many results to request from an engine that cannot page. |
| `WebSearch.windowSlice` | Function: cut one slice from a ranked list and find what follows it. |
| `WebSearch.readPublishedAt` | Function: read a reported date into an instant, or null. |

This module has no engine of its own. An engine module extends
`WebSearch.Engine`, and the application declares that engine. The functions are
what engines are built from; a caller never needs them.

## Example

A library that searches with whatever engine its importer supplies:

```yaml
kind: Telo.Library
metadata: { name: Research, version: 1.0.0 }
imports:
  WebSearch: oci://ghcr.io/telorun/web-search@0.2.0
  Run: oci://ghcr.io/telorun/run@0.27.1
resources:
  engine: { kind: WebSearch.Engine }
exports:
  resources: [firstPage]
---
kind: Run.Sequence
metadata: { name: firstPage }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [topic]
    properties:
      topic: { type: string, minLength: 1 }
steps:
  - name: search
    invoke: !ref engine
    timeout: 15000
    inputs:
      query: !cel "inputs.topic"
      count: 10
      language: en
      freshness: month
outputs:
  links: !cel "steps.search.result.results.map(r, r.url)"
  next: !cel "has(steps.search.result.nextCursor) ? steps.search.result.nextCursor : ''"
```

## Documentation

- [`WebSearch.Engine`](./docs/engine.md): the contract, paging, hints, failure
  codes and deadlines.
- [Writing an engine](./docs/authoring-an-engine.md): the engine shape and the
  seven functions, for someone adding a search engine.
