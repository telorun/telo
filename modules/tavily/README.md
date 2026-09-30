# Tavily

Web search through the [Tavily Search API](https://docs.tavily.com/), built for
AI agents and retrieval: ranked results with title, URL, content snippet and
publication date, up to 20 per query, sliced with an opaque cursor.

## Why use this

- **The engine-neutral contract.** `Tavily.WebSearchEngine` implements
  `WebSearch.Engine`, so a library typed against the contract takes it
  unchanged, and another engine can replace it later.
- **Made for agents.** Tavily returns content excerpts meant to be read by a
  model, and the engine asks for publication dates on every result.
- **Language, country and recency.** The contract's hints map onto Tavily's
  `language`, `country` and `time_range` parameters; a hint Tavily has no form
  for is left out.
- **Plain Telo.** The engine is a templated kind with no controller: its whole
  mapping — request, paging, dates, errors — is readable in its `telo.yaml`.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Tavily.WebSearchEngine` | Search the web through the Tavily API. |

## Example

The API key is a credential on the HTTP client the engine is reached through:

```yaml
kind: Telo.Application
metadata: { name: Search, version: 1.0.0 }
imports:
  Tavily: oci://ghcr.io/telorun/tavily@0.2.0
  Http: oci://ghcr.io/telorun/http-client@0.22.3
  Run: oci://ghcr.io/telorun/run@0.27.1
  Console: oci://ghcr.io/telorun/console@0.18.1
secrets:
  tavilyKey: { env: TAVILY_API_KEY, type: string }
targets:
  - !ref search
---
kind: Tavily.WebSearchEngine
metadata: { name: web }
safeSearch: true
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: https://api.tavily.com
    timeout: 10000
    credential:
      kind: Http.BearerToken
      token: !cel "secrets.tavilyKey"
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

- [`Tavily.WebSearchEngine`](./docs/web-search-engine.md): credentials,
  configuration, how the query and hints map onto Tavily, paging, dates and
  failures.
- The contract it implements: [`WebSearch.Engine`](../web-search/docs/engine.md).
