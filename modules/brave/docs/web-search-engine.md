---
description: "Brave.WebSearchEngine: web search through the Brave Search API"
sidebar_label: Brave.WebSearchEngine
---

# Brave.WebSearchEngine

> Examples assume this module is imported under the alias `Brave`, `http-client` under `Http`. Substitute your own aliases.

`Brave.WebSearchEngine` implements [`WebSearch.Engine`](../../web-search/docs/engine.md) over the Brave Search API's `GET /res/v1/web/search`. Declare it where the application chooses its search engine; everything that consumes it types against the contract.

It is a templated kind with no controller: the request, paging, date handling and error mapping are all in its `telo.yaml`.

## Credentials and configuration

| Field | Type | Meaning |
| --- | --- | --- |
| `request` | `Http.Request`, required | The request Brave is reached through. Its client's `baseUrl` is `https://api.search.brave.com`; its credential is an `Http.ApiKeyHeader` sending the subscription token in `X-Subscription-Token`. Timeouts and retries belong to the client. |
| `safeSearch` | `off` \| `moderate` \| `strict`, default `moderate` | Sent as `safesearch`. |

```yaml
kind: Brave.WebSearchEngine
metadata: { name: web }
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: https://api.search.brave.com
    credential:
      kind: Http.ApiKeyHeader
      header: X-Subscription-Token
      key: !cel "secrets.braveToken"
```

## The request

| Contract input | Sent as |
| --- | --- |
| `query` | `q`, as written — Brave's own operators (`site:`, quotes) apply. |
| — | `count=20` and `offset`, the page (0–9); `safesearch`. |
| `country` | `country`, when it is one of the countries Brave lists (below); otherwise left out. |
| `language` | `search_lang`, when the tag or its primary subtag is a Brave language (below), ignoring case; otherwise left out. |
| `freshness` | `freshness`: `day` → `pd`, `week` → `pw`, `month` → `pm`, `year` → `py`. |
| `count`, `cursor` | Not sent: they decide which items of a page are returned (see Paging). |

**Countries:** `AR`, `AU`, `AT`, `BE`, `BR`, `CA`, `CL`, `DK`, `FI`, `FR`, `DE`, `GR`, `HK`, `IN`, `ID`, `IT`, `JP`, `KR`, `MY`, `MX`, `NL`, `NZ`, `NO`, `CN`, `PL`, `PT`, `PH`, `RU`, `SA`, `ZA`, `ES`, `SE`, `CH`, `TW`, `TR`, `GB`, `US`.

**Languages** (`search_lang` values): `ar`, `eu`, `bn`, `bg`, `ca`, `zh-hans`, `zh-hant`, `hr`, `cs`, `da`, `nl`, `en`, `en-gb`, `et`, `fi`, `fr`, `gl`, `de`, `el`, `gu`, `he`, `hi`, `hu`, `is`, `it`, `ja`, `jp`, `kn`, `ko`, `lv`, `lt`, `ms`, `ml`, `mr`, `nb`, `pl`, `pt-br`, `pt-pt`, `pa`, `ro`, `ru`, `sr`, `sk`, `sl`, `es`, `sv`, `ta`, `te`, `th`, `tr`, `uk`, `vi`. `no` (Norwegian) is sent as `nb`. `pt`, `zh`, `zh-CN`, `zh-TW` and other tags whose Brave form would be a guess are left out.

## The results

| Result field | From |
| --- | --- |
| `title` | `title`, `""` when absent. |
| `url` | `url`, exactly as reported — neither normalized nor percent-encoded, so it may be an IRI. A result with no URL is dropped. |
| `snippet` | `description`, as Brave writes it (it may carry `<strong>` emphasis), `""` when absent. |
| `publishedAt` | `page_age`, read by `WebSearch.readPublishedAt`: an RFC 3339 / ISO 8601 date-time (without an offset, UTC), a bare date (midnight UTC) or an HTTP date. A null, unreadable or impossible date (`2026-02-30`) is left out, never a failure. |

Only web results are returned; Brave's news, videos, discussions and other sections are not part of the contract.

## Paging

Brave serves ten pages of 20 results (`offset` 0–9), and the engine always asks for the full 20:

- A cursor's position is `<offset>-<skip>`. The first call reads offset 0 from its start.
- A call makes one request and returns at most `count` results of that page from `skip`; without `count`, the rest of the page.
- Results left on the page give a cursor to the same page further on. Otherwise a cursor to the next offset is issued only when Brave reports `more_results_available` and the offset is below 9.
- A cursor is valid with any `count`.

## Failures

| Code | When |
| --- | --- |
| `ERR_INVALID_INPUT` | The cursor is malformed, was issued by another engine, or was issued for a different query, language, country or freshness. Raised before any request. |
| `ERR_SEARCH_ACCESS_DENIED` | Brave rejected the token (`SUBSCRIPTION_TOKEN_INVALID`, which Brave sends as 422). |
| `ERR_SEARCH_QUOTA_EXCEEDED` | Brave answered `QUOTA_LIMITED`: the plan's quota is used up. |
| `ERR_SEARCH_RATE_LIMITED` | Brave answered 429 for the request rate. |
| `ERR_SEARCH_FAILED` | Any other error — a 422 for a parameter means the engine's own mapping is wrong — a 200 whose body is not Brave's search response, or an API that could not be reached. The message carries Brave's error code and detail. |

The engine reads the status and Brave's error code itself. A client declared with `throwOnHttpError: true` is handled the same way, so no transport code reaches the caller.
