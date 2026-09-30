# Brave

Web search through the [Brave Search API](https://brave.com/search/api/), an
independent web index: ranked results with title, URL, snippet and page age,
paging with an opaque cursor over Brave's first ten pages.

## Why use this

- **The engine-neutral contract.** `Brave.WebSearchEngine` implements
  `WebSearch.Engine`, so a library typed against the contract takes it
  unchanged, and another engine can replace it later.
- **An independent index.** Results come from Brave's own crawl rather than a
  reseller of another engine's results.
- **Country, language and recency.** The contract's hints map onto Brave's
  `country`, `search_lang` and `freshness` parameters wherever Brave has a
  matching code; others are left out rather than refused.
- **Plain Telo.** The engine is a templated kind with no controller: its whole
  mapping — request, paging, dates, errors — is readable in its `telo.yaml`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Brave.WebSearchEngine` | Search the web through the Brave API. |

## Example

The API key is a credential on the HTTP client the engine is reached through:

```yaml
kind: Telo.Application
metadata: { name: Search, version: 1.0.0 }
imports:
  Brave: oci://ghcr.io/telorun/brave@0.2.0
  Http: oci://ghcr.io/telorun/http-client@0.22.3
  Run: oci://ghcr.io/telorun/run@0.27.1
  Console: oci://ghcr.io/telorun/console@0.18.1
secrets:
  braveToken: { env: BRAVE_API_KEY, type: string }
targets:
  - !ref search
---
kind: Brave.WebSearchEngine
metadata: { name: web }
safeSearch: strict
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: https://api.search.brave.com
    timeout: 10000
    credential:
      kind: Http.ApiKeyHeader
      header: X-Subscription-Token
      key: !cel "secrets.braveToken"
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

- [`Brave.WebSearchEngine`](./docs/web-search-engine.md): credentials,
  configuration, how the query and hints map onto Brave, paging, dates and
  failures.
- The contract it implements: [`WebSearch.Engine`](../web-search/docs/engine.md).
