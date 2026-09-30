# Kagi

Web search through the [Kagi Search API](https://help.kagi.com/kagi/api/search.html),
an ad-free paid search service: ranked results with title, URL, snippet and
date, paging with an opaque cursor over Kagi's first ten pages.

## Why use this

- **The engine-neutral contract.** `Kagi.WebSearchEngine` implements
  `WebSearch.Engine`, so a library typed against the contract takes it
  unchanged, and another engine can replace it later.
- **Ad-free results.** Kagi's index, with no advertising in the ranking.
- **Region and recency.** The country hint becomes Kagi's region filter and the
  recency hint a start date covering the whole window.
- **Plain Telo.** The engine is a templated kind with no controller: its whole
  mapping — request, paging, dates, errors — is readable in its `telo.yaml`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Kagi.WebSearchEngine` | Search the web through the Kagi API. |

## Example

The API key is a credential on the HTTP client the engine is reached through:

```yaml
kind: Telo.Application
metadata: { name: Search, version: 1.0.0 }
imports:
  Kagi: oci://ghcr.io/telorun/kagi@0.2.0
  Http: oci://ghcr.io/telorun/http-client@0.22.3
  Run: oci://ghcr.io/telorun/run@0.27.1
  Console: oci://ghcr.io/telorun/console@0.18.1
secrets:
  kagiToken: { env: KAGI_API_KEY, type: string }
targets:
  - !ref search
---
kind: Kagi.WebSearchEngine
metadata: { name: web }
safeSearch: true
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: https://kagi.com
    timeout: 10000
    credential:
      kind: Http.BearerToken
      token: !cel "secrets.kagiToken"
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

- [`Kagi.WebSearchEngine`](./docs/web-search-engine.md): credentials,
  configuration, how the query and hints map onto Kagi, paging, dates and
  failures.
- The contract it implements: [`WebSearch.Engine`](../web-search/docs/engine.md).
