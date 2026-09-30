---
description: "Tavily.WebSearchEngine: web search through the Tavily Search API"
sidebar_label: Tavily.WebSearchEngine
---

# Tavily.WebSearchEngine

> Examples assume this module is imported under the alias `Tavily`, `http-client` under `Http`. Substitute your own aliases.

`Tavily.WebSearchEngine` implements [`WebSearch.Engine`](../../web-search/docs/engine.md) over the Tavily Search API's `POST /search`. Declare it where the application chooses its search engine; everything that consumes it types against the contract.

It is a templated kind with no controller: the request, slicing, date handling and error mapping are all in its `telo.yaml`.

## Credentials and configuration

| Field | Type | Meaning |
| --- | --- | --- |
| `request` | `Http.Request`, required | The request Tavily is reached through. Its client's `baseUrl` is `https://api.tavily.com`; its credential is an `Http.BearerToken` holding the API key (`tvly-…`). Timeouts and retries belong to the client. |
| `safeSearch` | boolean, default `false` | Sent as `safe_search`. |

```yaml
kind: Tavily.WebSearchEngine
metadata: { name: web }
request:
  kind: Http.Request
  client:
    kind: Http.Client
    baseUrl: https://api.tavily.com
    credential:
      kind: Http.BearerToken
      token: !cel "secrets.tavilyKey"
```

## The request

The body is JSON:

| Contract input | Sent as |
| --- | --- |
| `query` | `query`, as written. |
| — | Always `topic: general`, `search_depth: basic`, `include_published_date: true`, `include_answer: false`, `include_raw_content: false`; `safe_search`. |
| `count`, `cursor` | `max_results`: the slice plus one probe result, at most 20 (see Slicing). |
| `language` | `language`: the tag's primary subtag when it is a two-letter ISO 639-1 code (`pt-BR` → `pt`); otherwise left out. Tavily boosts it; it does not filter. |
| `country` | `country`: Tavily's country name for the code (table below); a code with no Tavily name is left out. Tavily boosts it; it does not filter. |
| `freshness` | `time_range`, as is (`day`, `week`, `month`, `year`). |

## The results

| Result field | From |
| --- | --- |
| `title` | `title`, `""` when absent. |
| `url` | `url`, exactly as reported — neither normalized nor percent-encoded, so it may be an IRI. A result with no URL is dropped. |
| `snippet` | `content`, `""` when absent. |
| `publishedAt` | `published_date` (Tavily sends an HTTP date, `Tue, 11 Mar 2025 17:00:00 GMT`), read by `WebSearch.readPublishedAt`: an RFC 3339 / ISO 8601 date-time (without an offset, UTC), a bare date (midnight UTC) or an HTTP date. A null, unreadable or impossible date (`2026-02-30`) is left out, never a failure. |

## Slicing

Tavily returns one ranked list of at most 20 results and cannot page, so those 20 are everything the engine can reach:

- A cursor's position is an offset (0–19) into that list. The first call starts at 0.
- A call asks for `offset + count + 1` results (at most 20) and returns `count` of them from the offset; without `count`, everything from the offset. The one extra result is how the engine knows more remain.
- A cursor is issued while results remain after the slice within the first 20, so walking the cursors ends after the 20th result. Each call repeats the search, so a result list that changes between calls can shift.
- A cursor is valid with any `count`.

## Failures

| Code | When |
| --- | --- |
| `ERR_INVALID_INPUT` | The cursor is malformed, was issued by another engine, or was issued for a different query, language, country or freshness. Raised before any request. |
| `ERR_SEARCH_ACCESS_DENIED` | Tavily answered 401: the API key is missing or invalid. |
| `ERR_SEARCH_RATE_LIMITED` | Tavily answered 429. |
| `ERR_SEARCH_QUOTA_EXCEEDED` | Tavily answered 432 (the plan's limit) or 433 (the pay-as-you-go limit). |
| `ERR_SEARCH_FAILED` | Any other status — a 400 or 422 means the engine's own mapping is wrong, a 5xx is Tavily's — a 200 whose body is not Tavily's search response, or an API that could not be reached. The message carries Tavily's `detail`. |

The engine reads the status itself. A client declared with `throwOnHttpError: true` is handled the same way, so no transport code reaches the caller.

## Countries

ISO 3166-1 alpha-2 codes and the Tavily names they are sent as. `CG` and `CD` are not mapped: Tavily has one name, `congo`, for both.

| Code | Tavily name |
| --- | --- |
| `AD` | andorra |
| `AE` | united arab emirates |
| `AF` | afghanistan |
| `AL` | albania |
| `AM` | armenia |
| `AO` | angola |
| `AR` | argentina |
| `AT` | austria |
| `AU` | australia |
| `AZ` | azerbaijan |
| `BA` | bosnia and herzegovina |
| `BB` | barbados |
| `BD` | bangladesh |
| `BE` | belgium |
| `BF` | burkina faso |
| `BG` | bulgaria |
| `BH` | bahrain |
| `BI` | burundi |
| `BJ` | benin |
| `BN` | brunei |
| `BO` | bolivia |
| `BR` | brazil |
| `BS` | bahamas |
| `BT` | bhutan |
| `BW` | botswana |
| `BY` | belarus |
| `BZ` | belize |
| `CA` | canada |
| `CF` | central african republic |
| `CH` | switzerland |
| `CL` | chile |
| `CM` | cameroon |
| `CN` | china |
| `CO` | colombia |
| `CR` | costa rica |
| `CU` | cuba |
| `CV` | cape verde |
| `CY` | cyprus |
| `CZ` | czech republic |
| `DE` | germany |
| `DJ` | djibouti |
| `DK` | denmark |
| `DO` | dominican republic |
| `DZ` | algeria |
| `EC` | ecuador |
| `EE` | estonia |
| `EG` | egypt |
| `ER` | eritrea |
| `ES` | spain |
| `ET` | ethiopia |
| `FI` | finland |
| `FJ` | fiji |
| `FR` | france |
| `GA` | gabon |
| `GB` | united kingdom |
| `GE` | georgia |
| `GH` | ghana |
| `GM` | gambia |
| `GN` | guinea |
| `GQ` | equatorial guinea |
| `GR` | greece |
| `GT` | guatemala |
| `HN` | honduras |
| `HR` | croatia |
| `HT` | haiti |
| `HU` | hungary |
| `ID` | indonesia |
| `IE` | ireland |
| `IL` | israel |
| `IN` | india |
| `IQ` | iraq |
| `IR` | iran |
| `IS` | iceland |
| `IT` | italy |
| `JM` | jamaica |
| `JO` | jordan |
| `JP` | japan |
| `KE` | kenya |
| `KG` | kyrgyzstan |
| `KH` | cambodia |
| `KM` | comoros |
| `KP` | north korea |
| `KR` | south korea |
| `KW` | kuwait |
| `KZ` | kazakhstan |
| `LB` | lebanon |
| `LI` | liechtenstein |
| `LK` | sri lanka |
| `LR` | liberia |
| `LS` | lesotho |
| `LT` | lithuania |
| `LU` | luxembourg |
| `LV` | latvia |
| `LY` | libya |
| `MA` | morocco |
| `MC` | monaco |
| `MD` | moldova |
| `ME` | montenegro |
| `MG` | madagascar |
| `MK` | north macedonia |
| `ML` | mali |
| `MM` | myanmar |
| `MN` | mongolia |
| `MR` | mauritania |
| `MT` | malta |
| `MU` | mauritius |
| `MV` | maldives |
| `MW` | malawi |
| `MX` | mexico |
| `MY` | malaysia |
| `MZ` | mozambique |
| `NA` | namibia |
| `NE` | niger |
| `NG` | nigeria |
| `NI` | nicaragua |
| `NL` | netherlands |
| `NO` | norway |
| `NP` | nepal |
| `NZ` | new zealand |
| `OM` | oman |
| `PA` | panama |
| `PE` | peru |
| `PG` | papua new guinea |
| `PH` | philippines |
| `PK` | pakistan |
| `PL` | poland |
| `PT` | portugal |
| `PY` | paraguay |
| `QA` | qatar |
| `RO` | romania |
| `RS` | serbia |
| `RU` | russia |
| `RW` | rwanda |
| `SA` | saudi arabia |
| `SD` | sudan |
| `SE` | sweden |
| `SG` | singapore |
| `SI` | slovenia |
| `SK` | slovakia |
| `SN` | senegal |
| `SO` | somalia |
| `SS` | south sudan |
| `SV` | el salvador |
| `SY` | syria |
| `TD` | chad |
| `TG` | togo |
| `TH` | thailand |
| `TJ` | tajikistan |
| `TM` | turkmenistan |
| `TN` | tunisia |
| `TR` | turkey |
| `TT` | trinidad and tobago |
| `TW` | taiwan |
| `TZ` | tanzania |
| `UA` | ukraine |
| `UG` | uganda |
| `US` | united states |
| `UY` | uruguay |
| `UZ` | uzbekistan |
| `VE` | venezuela |
| `VN` | vietnam |
| `YE` | yemen |
| `ZA` | south africa |
| `ZM` | zambia |
| `ZW` | zimbabwe |
