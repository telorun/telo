---
description: "Kagi.WebSearchEngine: web search through the Kagi Search API"
sidebar_label: Kagi.WebSearchEngine
---

# Kagi.WebSearchEngine

> Examples assume this module is imported under the alias `Kagi`, `http-client` under `Http`. Substitute your own aliases.

`Kagi.WebSearchEngine` implements [`WebSearch.Engine`](../../web-search/docs/engine.md) over the Kagi Search API's `POST /api/v1/search`. Declare it where the application chooses its search engine; everything that consumes it types against the contract.

It is a templated kind with no controller: the request, paging, date handling and error mapping are all in its `telo.yaml`.

## Credentials and configuration

| Field | Type | Meaning |
| --- | --- | --- |
| `request` | `Http.Request`, required | The request Kagi is reached through. Its client's `baseUrl` is `https://kagi.com`; its credential is an `Http.BearerToken` holding the API token. Timeouts and retries belong to the client. |
| `safeSearch` | boolean, default `false` | Sent as `safe_search`. |

```yaml
kind: Kagi.WebSearchEngine
metadata: { name: web }
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: https://kagi.com
    credential:
      kind: Http.BearerToken
      token: !cel "secrets.kagiToken"
```

## The request

The body is JSON:

| Contract input | Sent as |
| --- | --- |
| `query` | `query`, as written. |
| — | `page` (1–10), `safe_search`. `limit` is never sent: Kagi decides the page size. |
| `country` | `filters.region`, as written (an uppercase ISO 3166-1 alpha-2 code). Kagi publishes no list of the regions it supports. |
| `freshness` | `filters.after`: the date of the day before the window starts (the current time minus 1, 7, 31 or 366 days), so the whole window is inside the filter whether Kagi reads `after` inclusively or not. |
| `language` | Nothing: Kagi has no language parameter. |
| `count`, `cursor` | Not sent: they decide which items of a page are returned (see Paging). |

## The results

| Result field | From |
| --- | --- |
| `title` | `title`, `""` when absent. |
| `url` | `url`, exactly as reported — neither normalized nor percent-encoded, so it may be an IRI. A result with no URL is dropped. |
| `snippet` | `snippet`, `""` when absent. |
| `publishedAt` | `time`, read by `WebSearch.readPublishedAt`: an RFC 3339 / ISO 8601 date-time (without an offset, UTC), a bare date (midnight UTC) or an HTTP date. A null, unreadable or impossible date (`2026-02-30`) is left out, never a failure. |

## Paging

Kagi serves pages 1–10 of a size it decides, so the engine never assumes one:

- A cursor's position is `<page>-<skip>`. The first call reads page 1 from its start.
- A call reads the page its cursor names and returns at most `count` of its results from `skip`; without `count`, the rest of the page.
- Results left on the page give a cursor to the same page further on. When the slice reaches the end of a non-empty page below 10, the engine reads the next page too — it is not returned — and gives a cursor to it only when it holds results. An empty page is the end, and page 10 has no successor. So a call makes at most two requests.
- A cursor is valid with any `count`.

## Failures

| Code | When |
| --- | --- |
| `ERR_INVALID_INPUT` | The cursor is malformed, was issued by another engine, or was issued for a different query, language, country or freshness. Raised before any request. |
| `ERR_SEARCH_ACCESS_DENIED` | Kagi answered 400 `general.invalid_token`, 401 (no token) or 403 (the caller's address is not authorized). |
| `ERR_SEARCH_RATE_LIMITED` | Kagi answered 429, which it uses both for the request rate and for exhausted usage. |
| `ERR_SEARCH_FAILED` | Any other error — another 400 means the engine's own mapping is wrong — a 200 whose body is not Kagi's search response, or an API that could not be reached. The message carries Kagi's error code and message. |

The engine reads the status and Kagi's `errors` itself. A client declared with `throwOnHttpError: true` is handled the same way, so no transport code reaches the caller.
