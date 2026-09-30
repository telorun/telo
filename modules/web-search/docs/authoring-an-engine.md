---
description: "Writing a web search engine for WebSearch.Engine: the engine shape, cursors, hints, paging, dates and the seven shared functions"
sidebar_label: Writing an engine
---

# Writing a web search engine

> Examples assume `web-search` is imported under the alias `WebSearch`, `http-client` under `Http` and `run` under `Run`.

An engine is plain Telo: a templated `Telo.Definition` with no controller that maps the contract onto one search API through an HTTP request the application supplies. Everything that is the same for every engine — cursors, hint resolution, recency windows, slicing, reading reported dates — is one of this module's exported functions, so an engine is only its own vocabulary and its own status codes.

## The engine shape

A complete engine for an API that returns one list of at most 50 results; it checks clean as written:

```yaml
kind: Telo.Definition
metadata:
  name: WebSearchEngine
capability: Telo.Invocable
extends: WebSearch.Engine
throws:
  codes:
    ERR_INVALID_INPUT: { description: "The cursor is malformed, foreign, or for other inputs." }
    ERR_SEARCH_RATE_LIMITED: { description: The API answered 429. }
    ERR_SEARCH_FAILED: { description: Any other failure. }
schema:
  type: object
  required: [request]
  additionalProperties: false
  properties:
    request:
      x-telo-ref: { kind: Http.Request, use: call }
resources:
  - kind: Run.Sequence
    metadata: { name: search }
    inputType: !ref WebSearch.Query
    outputType: !ref WebSearch.Results
    steps:
      - name: languages        # the engine's own vocabulary, as data
        value: { en: en, de: de, pt-BR: pt-BR }
      - name: cursor           # this API returns one list of at most 50 results
        value: !cel "WebSearch.openCursor('myengine', inputs, '^(0|[1-9][0-9]?)$', '0')"
      - name: refuse
        if: !cel "!steps.cursor.result.valid"
        then:
          - name: invalidCursor
            throw:
              code: ERR_INVALID_INPUT
              message: !cel "steps.cursor.result.message"
      - name: window
        value:
          offset: !cel "int(steps.cursor.result.position)"
          count: !cel "has(inputs.count) ? inputs.count : 50"
      - name: fetch
        try:
          - name: http
            invoke: !cel "self.request"
            inputs:
              url: /search
              method: GET
              responseType: json
              query: !cel >-
                compact({'q': inputs.query,
                  'limit': string(WebSearch.windowRequest(steps.window.result.offset, steps.window.result.count, 50)),
                  'lang': WebSearch.resolveHint(has(inputs.language) ? inputs.language : null, steps.languages.result)})
        catch:
          # A client with `throwOnHttpError` raises the status; map it like any other.
          - name: unreachable
            if: !cel "error.code != 'ERR_HTTP_STATUS'"
            then:
              - name: transportFailed
                throw:
                  code: ERR_SEARCH_FAILED
                  message: !interpolate "The request to MyEngine failed: ${{ error.message }}"
          - name: raised
            value: !cel "int(error.data.status)"
      - name: status
        switch: !cel "string('http' in steps ? steps.http.result.status : steps.raised.result)"
        cases:
          "200": []
          "429":
            - name: limited
              throw: { code: ERR_SEARCH_RATE_LIMITED, message: The API answered 429. }
        default:
          - name: failed
            throw:
              code: ERR_SEARCH_FAILED
              message: !cel "'The API answered HTTP ' + string('http' in steps ? steps.http.result.status : steps.raised.result)"
      - name: readable
        if: !cel >-
          !(type(steps.http.result.body) == type({}) && 'results' in steps.http.result.body &&
            type(steps.http.result.body.results) == type([]))
        then:
          - name: unreadable
            throw: { code: ERR_SEARCH_FAILED, message: The API answered 200 with a body that is not its results. }
      - name: mapped
        value: !cel >-
          steps.http.result.body.results
            .filter(r, type(r) == type({}) && 'url' in r && type(r.url) == type(''))
            .map(r, cel.bind(at,
              WebSearch.readPublishedAt('date' in r && type(r.date) == type('') ? r.date : null),
              cel.bind(base, {
                  'title': 'title' in r && type(r.title) == type('') ? r.title : '',
                  'url': r.url,
                  'snippet': 'snippet' in r && type(r.snippet) == type('') ? r.snippet : ''
                },
                at == null ? base : merge(base, {'publishedAt': at}))))
      - name: slice
        value: !cel "WebSearch.windowSlice(steps.mapped.result, steps.window.result.offset, steps.window.result.count)"
      - name: shaped
        value: !cel >-
          steps.slice.result.next == null
            ? {'results': steps.slice.result.items}
            : {'results': steps.slice.result.items,
               'nextCursor': WebSearch.sealCursor('myengine', inputs, string(steps.slice.result.next))}
    outputs: !cel "steps.shaped.result"
invoke: !ref search
inputs: !cel "inputs"
```

What makes it an engine:

- **No contract of its own.** The definition declares no `inputType` / `outputType`; the abstract's is the one every call is checked against. The body entry is typed by the same named shapes, so `inputs.<field>` is checked inside it.
- **The network is the application's.** A required `request` slot, `x-telo-ref: { kind: Http.Request, use: call }`, reached with `invoke: !cel "self.request"`. The base URL, credentials (`Http.BearerToken`, `Http.ApiKeyHeader`, `Http.QueryKey`), timeout and retries live on the `Http.Client` the application declares. An engine never fetches on its own.
- **Configuration in the engine's own vocabulary.** A setting the contract does not carry — safe search, a region the API requires — is a field on the engine's schema, spelled the way the API spells it.
- **Tables are data.** A vocabulary map (language codes, country names) is a `value:` step at the head of the body, handed to `WebSearch.resolveHint`.
- **Every code is literal.** Each `throw:` names its code as a literal, so the codes a body can raise are readable from the manifest; map statuses with a `switch` whose `default` is `ERR_SEARCH_FAILED`. Declare exactly the codes the body raises in `throws:` — a subset of the contract's ceiling — and raise each one in a test.
- **The status is read, never raised as is.** Map the vendor's statuses and error bodies onto the contract's codes, and put the vendor's detail in the message. A 400 or 422 from the vendor means the engine's own mapping is wrong, so it is `ERR_SEARCH_FAILED`, not `ERR_INVALID_INPUT`. A client configured with `throwOnHttpError` raises `ERR_HTTP_STATUS` instead of returning the status; catch it, read `error.data.status`, and map it the same way, so no transport code escapes.
- **Vendor data is reported, not repaired.** A result's `url` is passed on exactly as the vendor reports it — it may be an IRI or carry unencoded characters — and a result without one is dropped. A date is read only through `WebSearch.readPublishedAt`, and one it cannot read is left out; unreadable vendor data never fails the call.
- **Hints never fail a call.** Map a hint through a table, or leave it out. Never forward a value the API does not understand and never refuse one.

## Cursors

A cursor is `<engine>.<digest>.<position>`: the engine's id, a 16-hex-digit digest of the inputs it answers, and a position in the engine's own form. `ERR_INVALID_INPUT` is reserved for a cursor the engine cannot honour — issued by another engine, for other inputs, or holding a position the engine's pattern does not accept.

**A cursor is a consistency check, not a security boundary.** Its digest is unsalted and its position is plain text, so anyone can build one. What it prevents is a caller following a cursor with the wrong engine or with changed inputs and silently reading an unrelated result set. An engine must treat the position it reads back as untrusted input: its pattern bounds every number in it, so nothing parsed from a cursor overflows or names a page the API cannot serve.

The digest covers `query`, `language` (lowercased), `country` and `freshness`, each length-prefixed, `~` for an absent one. `count` and `cursor` are excluded, which is what keeps a cursor valid under any `count`.

## Paging models

Three models cover the search APIs in use; pick the one the API has.

- **Numbered pages of a size the API decides.** Position `<page>-<skip>`. A call reads the page its position names and returns at most `count` items from `skip` (`windowSlice`). When items are left on the page, the next position is `<page>-<next>`. When the slice reaches the end of a non-empty page, read the following page (without returning it) and issue `<page+1>-0` only when it holds items; an empty page is the end. At most two requests per call.
- **Offset pages with a vendor "more" flag.** Position `<offset>-<skip>`, one request per call; the next position comes from items left on the page, else from the vendor's flag, and stops at the API's maximum offset.
- **One list, no paging.** Position is an offset into the list. Request `windowRequest(offset, count, maximum)` results — the slice plus one probe — and return `windowSlice(items, offset, count)`; the probe item is what shows another slice exists. The API's per-request maximum is the window: nothing beyond it is reachable.

In every model, `count` never changes what a cursor names, a slice shorter than `count` (or empty) with a `nextCursor` is legal, and `nextCursor` is issued only from evidence the vendor gave — an item left over, a flag, a non-empty next page — never guessed.

## The functions

All seven are `Telo.Function`s: deterministic, never throwing for inputs their signatures admit, and callable from any CEL in a module that imports `web-search`. The two cursor functions are host-backed, since they hash with `sha256`.

### `WebSearch.sealCursor(engine, query, position) → string`

The cursor to return as `nextCursor`: `engine + '.' + digest(query) + '.' + position`. `engine` is a lowercase id (`^[a-z][a-z0-9]*$`); `query` is the call's whole `inputs`.

```yaml
nextCursor: !cel "WebSearch.sealCursor('myengine', inputs, string(steps.position.result.page + 1))"
```

### `WebSearch.openCursor(engine, query, positionPattern, start) → { valid, position, message }`

Reads the cursor in `query.cursor`. With none, `{ valid: true, position: start }`. Otherwise it checks, in order, that the cursor was issued by `engine`, that its digest matches `query`, and that its position matches `positionPattern` — which must be anchored (`^…$`) and bound every number. A failed check returns `valid: false`, `position: ""` and a `message` naming the cause; the engine raises it as a literal `ERR_INVALID_INPUT`. It returns rather than throws because a function's failure would surface as `ERR_FUNCTION_FAILED`, a code no engine may raise.

### `WebSearch.resolveHint(hint, table) → string | null`

Looks `hint` up in `table` (a map from tags to the engine's own values): an exact key first, then the BCP 47 primary subtag, both ignoring case. `null` for a `null` hint or no match — pass the result through `compact(...)` so the parameter is left out.

### `WebSearch.freshnessStart(freshness, at) → timestamp`

The start of a recency window ending at `at`: 24 hours, 168 hours, 744 hours (31 days) or 8784 hours (366 days) earlier, so the window covers any calendar day, week, month or year. For an API whose recency filter is a start date; pass `now()`.

### `WebSearch.windowRequest(offset, count, window) → int`

`min(offset + count + 1, window)`: how many results to request from a list API so the slice and one probe item are covered, capped at the API's per-request maximum.

### `WebSearch.readPublishedAt(text) → timestamp | null`

Reads a date the vendor reports into the instant `publishedAt` carries. It accepts an RFC 3339 / ISO 8601 date-time with an optional fraction of up to nine digits and an optional offset (none means UTC), a bare `YYYY-MM-DD` (midnight UTC), and an HTTP date (`Tue, 11 Mar 2025 17:00:00 GMT`). Anything else is `null`, and so is an impossible calendar date (`2026-02-30`, never rolled over into March) and an instant outside the representable range. Pass `null` when the vendor sent no string, and leave `publishedAt` out when the result is `null`:

```yaml
.map(r, cel.bind(at,
  WebSearch.readPublishedAt('date' in r && type(r.date) == type('') ? r.date : null),
  at == null ? base : merge(base, {'publishedAt': at})))
```

### `WebSearch.windowSlice(items, offset, count) → { items, next }`

At most `count` items of `items` from `offset`, and `next`, the offset of the first item after the slice, or `null` when the slice reaches the end. An offset at or past the end yields `{ items: [], next: null }`.

## Testing an engine

Test offline: stand an `Http.Server` with an `Http.Api` up in a `Run.Sequence`'s `with:`, point the engine's `Http.Client` at it, and serve the vendor's documented bodies. To assert on the request the engine sends, echo it back — a route's `returns:` can put `json(request.query)` (or `json(request.body)`) into a result's title — and compare it with `Assert.Equals` after `parseJson`. Serve each test on a port of its own, raise every declared code, and compare instants as their text (`string(r.publishedAt)`).
