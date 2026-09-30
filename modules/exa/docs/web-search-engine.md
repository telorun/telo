---
description: "Exa.WebSearchEngine: web search through the Exa Search API"
sidebar_label: Exa.WebSearchEngine
---

# Exa.WebSearchEngine

> Examples assume this module is imported under the alias `Exa`, `http-client` under `Http`. Substitute your own aliases.

`Exa.WebSearchEngine` implements [`WebSearch.Engine`](../../web-search/docs/engine.md) over the Exa Search API's `POST /search`. Declare it where the application chooses its search engine; everything that consumes it types against the contract.

It is a templated kind with no controller: the request, slicing, date handling and error mapping are all in its `telo.yaml`.

## Credentials and configuration

| Field | Type | Meaning |
| --- | --- | --- |
| `request` | `Http.Request`, required | The request Exa is reached through. Its client's `baseUrl` is `https://api.exa.ai`; its credential is an `Http.ApiKeyHeader` sending the key in `x-api-key`. Timeouts and retries belong to the client. |
| `safeSearch` | boolean, default `false` | Sent as `moderation`. |

```yaml
kind: Exa.WebSearchEngine
metadata: { name: web }
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: https://api.exa.ai
    credential:
      kind: Http.ApiKeyHeader
      header: x-api-key
      key: !cel "secrets.exaKey"
```

## The request

The body is JSON:

| Contract input | Sent as |
| --- | --- |
| `query` | `query`, as written. |
| — | Always `contents: { highlights: true }`; `moderation`. No `type` is sent, so Exa chooses its default search type. |
| `count`, `cursor` | `numResults`: the slice plus one probe result, at most 100 (see Slicing). |
| `country` | `userLocation`, as written (an uppercase ISO 3166-1 alpha-2 code). |
| `freshness` | `startPublishedDate`: the start of the window — the current time minus 1, 7, 31 or 366 days — as an ISO 8601 date-time. |
| `language` | Nothing: Exa has no language parameter. |

## The results

| Result field | From |
| --- | --- |
| `title` | `title`, `""` when absent or null. |
| `url` | `url`, exactly as reported — neither normalized nor percent-encoded, so it may be an IRI. A result with no URL is dropped. |
| `snippet` | `highlights`, joined with ` [...] `; `""` when there are none. |
| `publishedAt` | `publishedDate`, read by `WebSearch.readPublishedAt`: an RFC 3339 / ISO 8601 date-time (without an offset, UTC), a bare date (midnight UTC) or an HTTP date. A null, unreadable or impossible date (`2026-02-30`) is left out, never a failure. |

## Slicing

Exa returns one ranked list of at most 100 results and cannot page, so those 100 are everything the engine can reach:

- A cursor's position is an offset (0–99) into that list. The first call starts at 0.
- A call asks for `offset + count + 1` results (at most 100) and returns `count` of them from the offset; without `count`, everything from the offset. The one extra result is how the engine knows more remain.
- A cursor is issued while results remain after the slice within the first 100, so walking the cursors ends after the 100th result. Each call repeats the search, so a result list that changes between calls can shift.
- A cursor is valid with any `count`.

The 100-result window assumes the documented public `numResults` maximum; a plan capped lower answers 400, which surfaces as `ERR_SEARCH_FAILED`.

## Failures

| Code | When |
| --- | --- |
| `ERR_INVALID_INPUT` | The cursor is malformed, was issued by another engine, or was issued for a different query, language, country or freshness. Raised before any request. |
| `ERR_SEARCH_ACCESS_DENIED` | Exa answered 401 (the API key is invalid) or 403 `FEATURE_DISABLED` (the key's plan does not include the request). |
| `ERR_SEARCH_QUOTA_EXCEEDED` | Exa answered 402: the credits or budget are used up. |
| `ERR_SEARCH_RATE_LIMITED` | Exa answered 429. |
| `ERR_SEARCH_FAILED` | Any other error — a 400 means the engine's own mapping is wrong, 403 `PROHIBITED_CONTENT` refuses the query, 500/503/504 are Exa's — a 200 whose body is not Exa's search response, or an API that could not be reached. The message carries Exa's tag and error. |

The engine reads the status and Exa's `tag` itself. A client declared with `throwOnHttpError: true` is handled the same way, so no transport code reaches the caller.
