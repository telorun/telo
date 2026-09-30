---
description: "SearXNG.WebSearchEngine: web search through a SearXNG instance's JSON API"
sidebar_label: SearXNG.WebSearchEngine
---

# SearXNG.WebSearchEngine

> Examples assume this module is imported under the alias `SearXNG`, `http-client` under `Http`. Substitute your own aliases.

`SearXNG.WebSearchEngine` implements [`WebSearch.Engine`](../../web-search/docs/engine.md) over a [SearXNG](https://docs.searxng.org/) instance's `GET /search` API. Declare it where the application chooses its search engine; everything that consumes it types against the contract.

It is a templated kind with no controller: the request, paging, date handling and error mapping are all in its `telo.yaml`.

## Configuration

| Field | Type | Meaning |
| --- | --- | --- |
| `request` | `Http.Request`, required | The request the instance is reached through. Its client's `baseUrl` is the instance root without a trailing slash (`http://localhost:8080`, `https://search.example.com/searx`); the engine requests `<baseUrl>/search`. Timeouts, retries and any headers a proxy in front of the instance needs belong to the client. |
| `safeSearch` | `off` \| `moderate` \| `strict`, default `moderate` | Sent as `safesearch` `0`, `1` or `2`. |

```yaml
kind: SearXNG.WebSearchEngine
metadata: { name: web }
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: http://localhost:8080
    timeout: 10000
```

### The instance must serve JSON

SearXNG answers `format=json` only when `json` is listed in `search.formats` of its `settings.yml`; the default lists `html` alone:

```yaml
search:
  formats:
    - html
    - json
```

An instance without it answers 403, which the engine reports as `ERR_SEARCH_ACCESS_DENIED` naming `search.formats`.

## The request

| Contract input | Sent as |
| --- | --- |
| `query` | `q`, as written — SearXNG's own syntax (`site:`, `!engine` bangs) applies. |
| — | `format=json`, `pageno`, `safesearch`. |
| `language` | `language`, when the engine's table has a form for it: an exact tag (`en-US`, `pt-BR`, `zh-TW`), else its primary subtag (`pt-AO` → `pt`), ignoring case. A tag with neither is left out. |
| `country` | Nothing: SearXNG has no country parameter. |
| `freshness` | `time_range`, as is (`day`, `week`, `month`, `year`). SearXNG passes it to the engines it aggregates; those without a recency filter ignore it, so older results can appear. |
| `count`, `cursor` | Not sent: they decide which items of a page are returned (see Paging). |

## The results

| Result field | From |
| --- | --- |
| `title` | `title`, `""` when absent. |
| `url` | `url`, exactly as reported — neither normalized nor percent-encoded, so it may be an IRI. A result with no URL is dropped. |
| `snippet` | `content`, `""` when absent or null. |
| `publishedAt` | `publishedDate` (SearXNG writes Python's `isoformat()`; fractional seconds are kept to the millisecond), read by `WebSearch.readPublishedAt`: an RFC 3339 / ISO 8601 date-time (without an offset, UTC), a bare date (midnight UTC) or an HTTP date. A null, unreadable or impossible date (`2026-02-30`) is left out, never a failure. |

SearXNG's answers, infoboxes, suggestions and corrections are not part of the contract and are not returned.

## Paging

SearXNG serves numbered pages whose size depends on the instance and the engines it aggregates, so the engine never assumes one:

- A cursor's position is `<pageno>-<skip>`: the page and how many of its results earlier calls already returned. The first call reads page 1 from its start.
- A call reads the page its cursor names and returns at most `count` of its results from `skip`; without `count`, the rest of the page.
- Items left on the page give a cursor to the same page further on. When the slice reaches the end of a non-empty page, the engine reads the next page too — it is not returned — and gives a cursor to it only when it holds results. An empty page is the end. So a call makes at most two requests.
- A cursor is valid with any `count`. Page 9999 is the last a cursor can name.

## Failures

| Code | When |
| --- | --- |
| `ERR_INVALID_INPUT` | The cursor is malformed, was issued by another engine, or was issued for a different query, language, country or freshness. Raised before any request. |
| `ERR_SEARCH_ACCESS_DENIED` | The instance answered 403: its JSON output is disabled. The message names `search.formats`. |
| `ERR_SEARCH_RATE_LIMITED` | The instance's limiter answered 429. |
| `ERR_SEARCH_FAILED` | Any other status (the message carries SearXNG's `error`, or the body text), a 200 whose body is not SearXNG's JSON results, or an instance that could not be reached. |

The engine reads the status itself. A client declared with `throwOnHttpError: true` is handled the same way: its `ERR_HTTP_STATUS` is mapped onto these codes, so no transport code reaches the caller.
