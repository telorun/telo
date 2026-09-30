---
description: "WebSearch.Engine: the engine-neutral contract for searching the web"
sidebar_label: WebSearch.Engine
---

# WebSearch.Engine

> Examples assume this module is imported under the alias `WebSearch`. Substitute your own alias if you import it under a different name.

`WebSearch.Engine` is an abstract `Telo.Invocable`: the contract every web search engine implements. It has no implementation of its own. An engine module declares a kind with `extends: WebSearch.Engine`, and the application declares that kind.

Type a slot against this abstract when it should accept any engine: a library's `resources:` entry (`engine: { kind: WebSearch.Engine }`), a template's reference slot, a blueprint's input. Declare the engine's own kind only where the engine is chosen.

The contract is the two exported shapes `WebSearch.Query` (input) and `WebSearch.Results` (output). Both are closed, so an argument or a result field that is not in them is a `telo check` error.

## Input — `WebSearch.Query`

| Field | Type | Meaning |
| --- | --- | --- |
| `query` | string, required, not empty | The query, passed to the engine as written — including any operators its own syntax accepts, such as `site:` or quotes. |
| `count` | integer ≥ 1 | At most this many results. Fewer are returned when the engine's per-request maximum or the window it can reach is smaller. Without it, the engine returns what one of its requests yields. |
| `cursor` | string | The `nextCursor` of an earlier call. Opaque. |
| `language` | string | A BCP 47 tag the results should be in (`en`, `pt-BR`). A hint. |
| `country` | string, `^[A-Z]{2}$` | An ISO 3166-1 alpha-2 country the results should be relevant to (`FI`). A hint. |
| `freshness` | `day` \| `week` \| `month` \| `year` | Prefer results published within this recent window. A hint. |

### Hints

`language`, `country` and `freshness` are hints, never filters a caller can rely on:

- An engine maps a hint onto its own vocabulary deterministically — an exact match first, then for a language its BCP 47 primary subtag (`pt-AO` → `pt`) — or leaves it out of its request. A hint is never refused and never forwarded in a form the engine does not understand.
- For `freshness`, an engine forwards the narrowest recency filter it has that still covers the whole window, or nothing. Results are not guaranteed to fall inside the window: many engines apply recency loosely, and some sources carry no date at all.

## Output — `WebSearch.Results`

| Field | Meaning |
| --- | --- |
| `results[]` | The results, best first: `{ title, url, snippet, publishedAt? }`. |
| `results[].title` | The page title. |
| `results[].url` | The page's URL exactly as the engine reports it: absolute, but neither normalized nor percent-encoded, so it may be an IRI (`https://de.wikipedia.org/wiki/Straße`) or hold a space. Encode it before handing it to something that requires an ASCII URI. |
| `results[].snippet` | An excerpt of the page, `""` when the engine has none. |
| `results[].publishedAt` | The date the engine reports for the page, as an instant, when it reports one that reads as a date. It is the reported date, not a verified one. |
| `nextCursor` | Present exactly when the engine can reach more results after this slice for the same inputs. |

## Paging

A call returns one slice. To read everything the engine can reach, pass each `nextCursor` back as `cursor` with the same `query`, `language`, `country` and `freshness`, until a result carries no `nextCursor`:

- A slice may be shorter than `count`, and may even be empty while a `nextCursor` is present. Only the absence of `nextCursor` means the end.
- A cursor is valid with any `count`, so a caller may change the slice size between calls.
- A cursor is bound to the kind of engine that issued it and to the inputs it was issued for. Passing it to another kind of engine, or with a different query, language, country or freshness, is `ERR_INVALID_INPUT`. Engine configuration such as `safeSearch` or the instance is not part of the binding, so pass a cursor back to the engine resource that issued it.
- How far an engine can reach is the engine's: several search APIs stop at a fixed depth.

```yaml
steps:
  - name: first
    invoke: !ref engine
    inputs: { query: !cel "inputs.topic", count: 20 }
  - name: more
    if: !cel "has(steps.first.result.nextCursor)"
    then:
      - name: second
        invoke: !ref engine
        inputs:
          query: !cel "inputs.topic"
          count: 20
          cursor: !cel "steps.first.result.nextCursor"
```

## Failures

Every implementation reports these codes. They are declared on the contract, so a `catches:` list or a retry policy written against it holds for any engine.

| Code | Meaning to the caller |
| --- | --- |
| `ERR_INVALID_INPUT` | The call was outside the contract: a malformed cursor, one issued by another engine, or one issued for different inputs. Fix the call. |
| `ERR_SEARCH_ACCESS_DENIED` | The engine refused the credentials or has the requested access disabled. Retrying will not help until the configuration changes. |
| `ERR_SEARCH_RATE_LIMITED` | The engine asked the caller to slow down. Retrying later may succeed. |
| `ERR_SEARCH_QUOTA_EXCEEDED` | The account's plan or credit limit is exhausted. Retrying will not help until it is renewed. |
| `ERR_SEARCH_FAILED` | The engine failed, was unreachable, or answered with something the implementation could not read. The message carries the engine's own detail. |

This list is a **ceiling**: an engine declares any subset of it and nothing beyond it, so a caller holding any engine knows every code it can be handed. `telo check` reports an engine declaring another code (`THROWS_NOT_SUBSTITUTABLE`). A raw HTTP status never reaches the caller; the vendor's detail is in the message.

## Deadlines are the caller's

The contract has no timeout. Bound a call with the step's `timeout:`, in milliseconds, or with the timeout of the HTTP client the engine's requests go through:

```yaml
steps:
  - name: search
    invoke: !ref engine
    timeout: 15000
    retry:
      attempts: 3
      nonRetryable: [ERR_INVALID_INPUT, ERR_SEARCH_ACCESS_DENIED, ERR_SEARCH_QUOTA_EXCEEDED]
    inputs:
      query: !cel "inputs.topic"
```
