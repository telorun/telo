# SearXNG

Web search through a self-hosted [SearXNG](https://docs.searxng.org/) metasearch
instance: query its JSON API and get back ranked results with title, URL, snippet
and publication date, paging with an opaque cursor. No API key is involved; the
instance is reached through an HTTP client you declare.

## Why use this

- **The engine-neutral contract.** `SearXNG.WebSearchEngine` implements
  `WebSearch.Engine`, so a library typed against the contract takes it unchanged,
  and another engine can replace it later.
- **Your own instance.** Results come from the engines your instance aggregates,
  with nothing sent to a commercial search API.
- **Plain Telo.** The engine is a templated kind with no controller: its whole
  mapping — request, paging, dates, errors — is readable in its `telo.yaml`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `SearXNG.WebSearchEngine` | Search the web through a SearXNG instance's `/search` JSON API. |

## Example

```yaml
kind: Telo.Application
metadata: { name: Search, version: 1.0.0 }
imports:
  SearXNG: oci://ghcr.io/telorun/searxng@0.2.0
  Http: oci://ghcr.io/telorun/http-client@0.22.3
  Run: oci://ghcr.io/telorun/run@0.27.1
  Console: oci://ghcr.io/telorun/console@0.18.1
variables:
  searxngUrl: { env: SEARXNG_URL, type: string, default: "http://localhost:8080" }
targets:
  - !ref search
---
kind: SearXNG.WebSearchEngine
metadata: { name: web }
safeSearch: strict
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: !cel "variables.searxngUrl"
    timeout: 10000
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

The instance must serve JSON: add `json` to `search.formats` in its
`settings.yml`. Without it every call fails with `ERR_SEARCH_ACCESS_DENIED`.

## Documentation

- [`SearXNG.WebSearchEngine`](./docs/web-search-engine.md): configuration, how
  the query and hints map onto SearXNG, paging, dates and failures.
- The contract it implements: [`WebSearch.Engine`](../web-search/docs/engine.md).
