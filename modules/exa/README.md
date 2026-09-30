# Exa

Web search through the [Exa Search API](https://docs.exa.ai/), a neural search
engine for AI applications: ranked results with title, URL, highlighted
excerpts and publication date, up to 100 per query, sliced with an opaque
cursor.

## Why use this

- **The engine-neutral contract.** `Exa.WebSearchEngine` implements
  `WebSearch.Engine`, so a library typed against the contract takes it
  unchanged, and another engine can replace it later.
- **Neural search.** Exa ranks by meaning, and returns highlights — the
  passages most relevant to the query — as each result's snippet.
- **Location and recency.** The country hint becomes Exa's `userLocation` and
  the recency hint a start date.
- **Plain Telo.** The engine is a templated kind with no controller: its whole
  mapping — request, paging, dates, errors — is readable in its `telo.yaml`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Exa.WebSearchEngine` | Search the web through the Exa API. |

## Example

The API key is a credential on the HTTP client the engine is reached through:

```yaml
kind: Telo.Application
metadata: { name: Search, version: 1.0.0 }
imports:
  Exa: oci://ghcr.io/telorun/exa@0.2.0
  Http: oci://ghcr.io/telorun/http-client@0.22.3
  Run: oci://ghcr.io/telorun/run@0.27.1
  Console: oci://ghcr.io/telorun/console@0.18.1
secrets:
  exaKey: { env: EXA_API_KEY, type: string }
targets:
  - !ref search
---
kind: Exa.WebSearchEngine
metadata: { name: web }
safeSearch: true
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: https://api.exa.ai
    timeout: 10000
    credential:
      kind: Http.ApiKeyHeader
      header: x-api-key
      key: !cel "secrets.exaKey"
---
kind: Run.Sequence
metadata: { name: search }
steps:
  - name: found
    invoke: !ref web
    inputs: { query: telo declarative runtime, count: 5, language: en, freshness: year }
  - name: print
    invoke: { kind: Console.WriteLine }
    inputs:
      output: !cel "steps.found.result.results.map(r, r.title + ' — ' + r.url).join('\\n')"
```

## Documentation

- [`Exa.WebSearchEngine`](./docs/web-search-engine.md): credentials,
  configuration, how the query and hints map onto Exa, paging, dates and
  failures.
- The contract it implements: [`WebSearch.Engine`](../web-search/docs/engine.md).
