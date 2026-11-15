---
status: draft
priority: medium
depends-on: [2026-11-15-library-migrations.md, 2026-11-05-ui-press-and-record-detail.md]
packages: [modules/ui, modules/ui-react, modules/http-server, modules/http-dispatch, analyzer/nodejs, kernel/nodejs, examples/ui-showcase, examples/report-console, examples/notes-web, examples/approval-workflow, examples/feedback-api-repo, examples/support-inbox-mcp, apps/hub, apps/authoring-agent, docs]
refinement: not-ready
---

# Queries: a declared read, apart from what draws it

## Problem

`Ui.Data` is one HTTP request welded to the trees drawn over its answer: `source`, `model`, `query`, `reloadOn` and `reloadEvery` describe a `GET`; `loading`, `content` and `failure` describe a drawing. Three things follow:

- **One answer cannot be drawn in two places.** The signed-in account in the layout's header and the same account in the page body are two `Ui.Data`, two requests, and two answers that can disagree.
- **Every new input to the request lands on the drawing.** A request body, the form a request reads — each becomes another key beside `content`, so one kind reads as having several sources.
- **A read can take no structured input.** It sends `GET` with scalar query parameters only. A read whose input is a record — a period with two dates and a few options, a search with nested criteria — is written as a `POST` route and run as a pressed `Ui.Action`, never re-read when its inputs change.

## Constraints

- kind name must be `Ui.Query`

## Surface

**Added**

- `Ui.Query` — a declared read: `model`, `url`, `input?`, `query?`, `reloadOn?`, `reloadEvery?`. It draws nothing.
- `Ui.Query.input` — `{ method?, model, body }`: what a read with a body sends; `method` is `QUERY` (default) or `POST`, `model` the `Telo.Type` the body is judged against, `body` a template of accessors and literals. Without `input` the read is a `GET`.
- `query` node — `{ type: query, query, children, loading?, failure? }` plus the shared node keys (`shown`, `fill`): draws one query's answer; `query` is a `!ref` to a `Ui.Query` or one inline, each tree a list of nodes.
- Wire: the `query` node with its three node lists, and `Ui.QuerySpec` `{ id, schema, method, url, input, query, reloadOn, reloadEvery? }` — `method` always filled (`GET` without `input`), `input` `null` or `{ body }`, `reloadEvery` omitted when not written, `id` the declaration's identity, the same in every document a mount serves.
- `Ui.Match.format` — `date` or `date-time`: a string condition, page query parameter or form value holds only text of that RFC 3339 form.
- `x-telo-eval: accessor-template` — an accessor field whose value may be a map or list, to any depth, each leaf a plain chain or a literal.
- Binding forms `{ map: { <key>: <binding> } }` and `{ list: [<binding>…] }` — what a controller receives at an `accessor-template` field holding a structure with a chain in it.
- `QUERY` — a value of the shared `HttpDispatch.Request` matcher's `method`, so a request `method` of an `Http.Api` route, taking a body like `POST`; and a method of the record contract, answered exactly as `GET` is.
- `UI_DATA_REPLACED` — the `ui` migration `queries`, rewriting a `Ui.Data` placement into a `query` node over a `Ui.Query`.

**Changed**

- A read is sent again when its request changes — its resolved address or its resolved body — where today only the address counts.
- The OpenAPI document `Http.Server` generates — `openapi: 3.2.0` (was `3.0.0`), a `QUERY` route listed under its path item's `query` operation.

**Removed**

- `Ui.Data` — an unknown kind (`UNDEFINED_KIND`) once `UI_DATA_REPLACED` has rewritten it; its wire `data` node with it.

## Solution

**A query is the read.** `Ui.Query` is a `Telo.Provider` publishing its `Ui.QuerySpec`; it is not a composite and draws nothing:

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the answer: a 2xx JSON object valid against it is a success |
| `url` | required | a `Ui.RequestTarget` over `query` and `params`, as `Ui.Data.source` was: an app-relative path, or `{ path, pathParams, queryParams }` |
| `input` | none | `{ method?, model, body }`; without it the read is `GET` |
| `query` | none | the page query parameters the query reads, read as `query` |
| `reloadOn` | none | `focus`, `unauthorized` |
| `reloadEvery` | none | a `Telo.Duration` of at least `5s` |

**A read with a body says what it sends.** `input.method` is `QUERY` — the safe method with a body, which declares that a read sent again on every change, focus and tick is harmless — unless written `POST`; any other method, `GET` included, is `SCHEMA_VIOLATION`, so a body under `GET` cannot be written. An intermediary that does not forward `QUERY` (some CDNs, gateways and firewalls) answers with a status the node's `failure` draws; the fix is `input.method: POST` with the route declared `POST`, and `query.md` and the `http-server` route docs say so. `input.body` is an `accessor-template` field — a JSON template to any depth, each leaf a plain chain over `query` and `params` or a literal — judged by `telo check` against `input.model` as a value is judged against a declared type (`x-telo-value-schema-from`): a literal that does not fit or a missing member is `SCHEMA_VIOLATION`, a chain whose type or format does not fit its member is `CEL_TYPE_ERROR`. The check types the value a chain holds when it holds one; a chain that may hold nothing is admitted at a required member, and whether the request is complete is the route's to say. The address's `queryParams` stay typed by their own chains: a record is modelled, an address is not.

**What is sent.** A chain holding nothing (missing or `null`) leaves its member or list item out; a literal is sent as written, `null` included. The body is not judged in the browser: a body the route refuses is answered 400 with issues at `/body/…`, drawn by the node's `failure`. A `url` that resolves to nothing sends nothing and draws `failure` with `ERR_UI_ADDRESS_UNRESOLVED`, as today. An author who wants nothing drawn until a parameter is chosen hides the node with `shown`.

**Page parameters carry dates.** `Ui.Match` — the one profile the renderer interprets for conditions, page query parameters and form values — gains `format: date | date-time`. A query parameter declared `{ type: string, format: date }` holds only an RFC 3339 full-date, so `?to=oops` reads as absent, as any value its declaration refuses does today, and a chain over it fits a body member declared `format: date`.

Everything `Ui.Data` guaranteed is the query's: at most one read in flight, an answer to a request the query no longer makes never drawn, re-reads on `focus`, on `reloadEvery`, on an announced path. A query never announces a path, and path-keyed invalidation matches a `QUERY` or `POST` read by its path as it matches a `GET`.

**Structured accessor values are opted into.** `x-telo-eval: accessor-template` is the accessor mode whose value may also be a map or list of accessor values, at any depth; a computed value anywhere in it that is not a plain chain is `ACCESSOR_NOT_PLAIN_CHAIN` / `ERR_ACCESSOR_NOT_PLAIN_CHAIN`. Every `accessor` field keeps its grammar — chain or literal — so no existing controller receives a structure. A structure holding a chain reaches the controller as `{ map }` or `{ list }` of bindings; one holding none is `{ value }`. The analyzer judges each leaf as an accessor at its own path; the kernel's binding builder and every resolver of a template's bindings (`ui`, `ui-react`) handle the two forms, held to one vector set. A context binding marked `x-telo-context-eval: accessor` is in scope at an `accessor-template` field; `x-telo-context-eval` gains no value. `x-telo-match-for` and `x-telo-text-values-for` naming an `accessor-template` field are refused at the kind with their own codes (`MATCH_FOR_INVALID`, `TEXT_VALUES_INVALID`); a rule or callable data slot reading one reads its binding as plain data, and the reachable walk reads `{ map }` and `{ list }` as holding no reference, since no leaf can be a `!ref`. A union whose branches declare one property as `accessor` and as `accessor-template` is `EVAL_MODE_BRANCH_CONFLICT`, as for any two modes.

**A `query` node draws one.** `{ type: query, query, children, loading?, failure? }` is a group, laid out as a `box` lays out its `children`, carrying `shown` and `fill` as every node does and transparent to `fill`. `children` are over `data` (typed from the query's `model`), `failure` over `error` (a `Ui.RequestError`), `loading` drawn before the first answer — each a list of nodes, each also over `query` (typed from the query's own `query`) and `params`; `ui` fills an omitted `loading` and `failure` as it filled `Ui.Data`'s, and `loading: []` draws nothing. `query` is a reference slot (`x-telo-ref`, `use: dependency`, kind `Ui.Query`) holding a `!ref` or an inline declaration; `data` and `query` are typed through it by `x-telo-context-ref-from`, so `data.nmae` is `CEL_UNKNOWN_FIELD` and a slot naming anything but a query is `REFERENCE_KIND_MISMATCH`. A query used by one node is written inline; one drawn by several gets a name. A `Ui.View` placed as a child is typed from each query node placing it by `x-telo-context-from-referrer`, as a view under `Ui.Data` is today.

**One query, one read.** Every `query` node naming the same `Ui.Query` — in the page, in the layout's header, in any document the mount serves — draws from one read, keyed by the declaration's identity and its resolved request: one request, one state; the nodes load, succeed and fail together, each drawing that state with its own trees, since a header wants a small placeholder where the body wants a large one. An inline `Ui.Query` inside a `Ui.View` placed twice is one declaration, so one read per resolved request. A read's state is held while at least one mounted node — shown, or hidden by `shown` — resolves to its key, and is dropped, its read in flight aborted, when the last such node unmounts or moves to another key: at most one state per held key, however often a body changes. It reads only while a holding node is shown; a trigger arriving while all are hidden reads once when one is shown. A node whose request changes keeps drawing its last answer until the new key answers; `loading` is drawn only before a node's first answer. `reloadOn: [unauthorized]` re-reads it when a request made by anything drawn in any of its nodes' `children` answers 401; its own read never counts. Two queries that happen to resolve to the same request stay two, so a change to one never silently changes the other.

**The server side.** `QUERY` joins the shared `HttpDispatch.Request` matcher's `method`, so `Http.Api` accepts it as a route method, with `request.schema.body` validated as for `POST`; a transport that cannot carry it narrows `method` in its own schema. The mount's cookie origin check treats `QUERY` as it treats `POST` — only `GET`, `HEAD` and `OPTIONS` are exempt — and the CORS default allowed methods are unchanged, so a cross-origin `QUERY` needs `cors.methods` (and `trustedOrigins` with a cookie credential), as `PUT` does; the docs say so. The generated OpenAPI document is `3.2.0` for every server declaring `openapi:` — the only version in which a `QUERY` operation is valid, and one version whatever routes a server holds — listing the operation under the path item's `query` key with its request body. The server's own document pass writes the version and the `query` operation whatever the document library emits, and the operations a host-routed mount's document filters by host include `query`.

**Migration.** `ui` ships the `Telo.Migration` `queries`, code `UI_DATA_REPLACED`: a `composite` node placing a `Ui.Data` — inline, or by `!ref` to a named one — becomes a `query` node; a named `Ui.Data` becomes a `Ui.Query`; `source` becomes `url`, `content` becomes `children: [<content>]`, and `loading` / `failure` become one-item lists on each placing node. The in-repo manifests are rewritten by `telo migrate` and formatted.

## Example

Before: the account is read twice, once by the header and once by the page.

```yaml
kind: Telo.Application
metadata: { name: HoursReport }
requires: { telo: ">=0.133.0" }
lang: en
imports:
  Http: ../../modules/http-server
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
targets:
  - !ref server
  - { name: openApp, invoke: !ref openApp, inputs: { url: !interpolate "http://localhost:${{ ports.http }}/report" } }
ports: { http: { env: PORT, protocol: tcp, default: 8150 } }
---
kind: Telo.JsonSchema
metadata: { name: Account }
schema:
  type: object
  required: [authorized]
  properties: { authorized: { type: boolean }, email: { type: string } }
---
kind: UiReact.App
metadata: { name: web }
title: Hours
pages:
  - kind: Ui.Page
    path: /report
    title: Report
    children:
      - type: composite
        ref:
          kind: Ui.Data
          model: !ref Account
          source: /api/auth
          reloadOn: [focus, unauthorized]
          content:
            type: text
            style: warning
            text: Sign in to see the report.
            shown: { at: !cel "data.authorized", matches: { const: false } }
layout:
  kind: Ui.PageLayout
  header:
    - type: composite
      ref:
        kind: Ui.Data
        model: !ref Account
        source: /api/auth
        reloadOn: [focus, unauthorized]
        loading: { type: stack, children: [] }
        content: { type: value, value: !cel "data.email", style: muted }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /api, mount: !ref api }
  - { path: /, mount: !ref web }
---
kind: Http.Api
metadata: { name: api }
routes:
  - request: { method: GET, path: /auth }
    handler:
      kind: Telo.Value
      outputType: !ref Account
      value: { authorized: true, email: ada@acme.test }
    returns:
      - { status: 200, content: { application/json: { body: !cel "result" } } }
---
kind: Telo.OpenUrl
metadata: { name: openApp }
```

Loading it reports the migration, and `telo migrate` writes it:

```text
$ telo check ./telo.yaml
warning  UiReact.App/web: [UI_DATA_REPLACED] pages[0].children[0]: Ui.Data is replaced by a query node over a Ui.Query; run `telo migrate`
warning  UiReact.App/web: [UI_DATA_REPLACED] layout.header[0]: Ui.Data is replaced by a query node over a Ui.Query; run `telo migrate`
$ telo migrate ./telo.yaml
telo.yaml: UI_DATA_REPLACED ×2
```

The `web` document it writes; every other document is as above:

```yaml
kind: UiReact.App
metadata: { name: web }
title: Hours
pages:
  - kind: Ui.Page
    path: /report
    title: Report
    children:
      - type: query
        query:
          kind: Ui.Query
          model: !ref Account
          url: /api/auth
          reloadOn: [focus, unauthorized]
        children:
          - type: text
            style: warning
            text: Sign in to see the report.
            shown: { at: !cel "data.authorized", matches: { const: false } }
layout:
  kind: Ui.PageLayout
  header:
    - type: query
      query:
        kind: Ui.Query
        model: !ref Account
        url: /api/auth
        reloadOn: [focus, unauthorized]
      loading: [{ type: stack, children: [] }]
      children: [{ type: value, value: !cel "data.email", style: muted }]
```

After: one `account` query read once for the header and the page, and a report read by `QUERY` whose body is a period and a project list the page's address chooses. With no `project` the body leaves `projects` out.

```yaml
kind: Telo.Application
metadata: { name: HoursReport }
requires: { telo: ">=unreleased" }
lang: en
imports:
  Http: ../../modules/http-server
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
targets:
  - !ref server
  - name: openApp
    invoke: !ref openApp
    inputs: { url: !interpolate "http://localhost:${{ ports.http }}/report?from=2026-11-01&to=2026-11-15" }
ports: { http: { env: PORT, protocol: tcp, default: 8150 } }
---
kind: Telo.JsonSchema
metadata: { name: Account }
schema:
  type: object
  required: [authorized]
  properties: { authorized: { type: boolean }, email: { type: string } }
---
kind: Telo.JsonSchema
metadata: { name: ReportRequest }
schema:
  type: object
  additionalProperties: false
  required: [period]
  properties:
    period:
      type: object
      additionalProperties: false
      required: [from, to]
      properties: { from: { type: string, format: date }, to: { type: string, format: date } }
    projects: { type: array, items: { type: string } }
---
kind: Telo.JsonSchema
metadata: { name: ReportAnswer }
schema:
  type: object
  required: [totalHours, items]
  properties:
    totalHours: { type: number }
    items:
      type: array
      items: { type: object, required: [name, hours], properties: { name: { type: string }, hours: { type: number } } }
---
# Drawn by the layout's header and by the page: one request between them.
kind: Ui.Query
metadata: { name: account }
model: !ref Account
url: /api/auth
reloadOn: [focus, unauthorized]
---
kind: UiReact.App
metadata: { name: web }
title: Hours
pages:
  - kind: Ui.Page
    path: /report
    title: Report
    children:
      - type: query
        query: !ref account
        loading: []
        children:
          - type: text
            style: warning
            text: Sign in to see the report.
            shown: { at: !cel "data.authorized", matches: { const: false } }
      - type: query
        query:
          kind: Ui.Query
          model: !ref ReportAnswer
          query:
            from: { type: string, format: date }
            to: { type: string, format: date }
            project: { type: array, items: { type: string } }
          url: /api/report
          input:
            method: QUERY
            model: !ref ReportRequest
            body:
              period: { from: !cel "query.from", to: !cel "query.to" }
              projects: !cel "query.project"
          reloadEvery: 1m
        loading: [{ type: text, text: Adding up the hours…, style: muted }]
        failure:
          - type: text
            style: warning
            text: { text: "The report could not be read: {$message}", values: { message: !cel "error.message" } }
        children:
          - type: text
            style: heading
            text: { text: "{$hours} hours", values: { hours: !cel "data.totalHours" } }
          - type: list
            rows: !cel "data.items"
            columns: [{ header: Project, value: !cel "row.name" }, { header: Hours, value: !cel "row.hours" }]
layout:
  kind: Ui.PageLayout
  header:
    - type: query
      query: !ref account
      loading: []
      failure: []
      children: [{ type: value, value: !cel "data.email", style: muted }]
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
openapi: { info: { title: Hours, version: 1.0.0 } }
mounts:
  - { path: /api, mount: !ref api }
  - { path: /docs, mount: { kind: Http.Reference } }
  - { path: /, mount: !ref web }
---
kind: Http.Api
metadata: { name: api }
routes:
  - request: { method: GET, path: /auth }
    handler:
      kind: Telo.Value
      outputType: !ref Account
      value: { authorized: true, email: ada@acme.test }
    returns:
      - { status: 200, content: { application/json: { body: !cel "result" } } }
  - request:
      method: QUERY
      path: /report
      schema:
        body:
          type: object
          additionalProperties: false
          required: [period]
          properties:
            period:
              type: object
              additionalProperties: false
              required: [from, to]
              properties: { from: { type: string, format: date }, to: { type: string, format: date } }
            projects: { type: array, items: { type: string } }
    inputs:
      period: !cel "request.body.period"
      projects: !cel "has(request.body.projects) ? request.body.projects : []"
    handler:
      kind: Telo.Value
      inputType: !ref ReportRequest
      outputType: !ref ReportAnswer
      value: { totalHours: 12.5, items: [{ name: Acme, hours: 8 }, { name: Core, hours: 4.5 }] }
    returns:
      - { status: 200, content: { application/json: { body: !cel "result" } } }
---
kind: Telo.OpenUrl
metadata: { name: openApp }
```

Refused, each a change to the After app:

```text
$ telo check ./telo.yaml        # input: { method: GET, ... }
error  UiReact.App/web: [SCHEMA_VIOLATION] pages[0].children[1].query.input.method must be one of QUERY, POST
$ telo check ./telo.yaml        # body: { perod: { ... } }
error  UiReact.App/web: [SCHEMA_VIOLATION] `pages[0].children[1].query.input.body` does not satisfy the type declared at `input.model`: must have required property 'period'
$ telo check ./telo.yaml        # query: { from: { type: string } }  (no format)
error  UiReact.App/web: [CEL_TYPE_ERROR] pages[0].children[1].query.input.body.period.from: query.from is a string, the member requires format date
$ telo check ./telo.yaml        # query: { from: { type: string, format: time } }
error  UiReact.App/web: [SCHEMA_VIOLATION] pages[0].children[1].query.query.from.format must be one of date, date-time
$ telo check ./telo.yaml        # period: { from: !cel "query.from + 'T00:00'" }
error  UiReact.App/web: [ACCESSOR_NOT_PLAIN_CHAIN] pages[0].children[1].query.input.body.period.from holds an expression, not a plain chain
$ telo check ./telo.yaml        # text: ... !cel "data.totalHuors"
error  UiReact.App/web: [CEL_UNKNOWN_FIELD] totalHuors is not a field of ReportAnswer
$ telo check ./telo.yaml        # query: !ref ReportAnswer
error  UiReact.App/web: [REFERENCE_KIND_MISMATCH] pages[0].children[0].query names a Telo.JsonSchema, not a Ui.Query
```

On the wire, `/report?from=2026-11-01&to=2026-11-15&project=acme`:

```http
QUERY /api/report HTTP/1.1
Content-Type: application/json

{ "period": { "from": "2026-11-01", "to": "2026-11-15" }, "projects": ["acme"] }

HTTP/1.1 200 OK
Content-Type: application/json

{ "totalHours": 12.5, "items": [{ "name": "Acme", "hours": 8 }, { "name": "Core", "hours": 4.5 }] }
```

`/report?from=2026-11-01` (no `to`). The same query written `input: { method: POST, model: !ref ReportRequest, body: … }` over a route declared `method: POST` sends the same exchange with `POST` in place of `QUERY`:

```http
QUERY /api/report HTTP/1.1
Content-Type: application/json

{ "period": { "from": "2026-11-01" } }

HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{ "status": 400, "code": "BAD_REQUEST", "issues": [{ "path": "/body/period/to", "message": "must have required property 'to'" }] }
```

The two specs the page carries:

```json
{ "id": "account", "schema": { "type": "object", "required": ["authorized"], "properties": { "authorized": { "type": "boolean" }, "email": { "type": "string" } } },
  "method": "GET", "url": { "value": "/api/auth" }, "input": null, "query": {}, "reloadOn": ["focus", "unauthorized"] }
{ "id": "web/pages/0/children/1/query",
  "schema": { "type": "object", "required": ["totalHours", "items"], "properties": { "totalHours": { "type": "number" },
    "items": { "type": "array", "items": { "type": "object", "required": ["name", "hours"], "properties": { "name": { "type": "string" }, "hours": { "type": "number" } } } } } },
  "method": "QUERY", "url": { "value": "/api/report" },
  "input": { "body": { "map": { "period": { "map": { "from": { "root": "query", "path": ["from"] }, "to": { "root": "query", "path": ["to"] } } }, "projects": { "root": "query", "path": ["project"] } } } },
  "query": { "from": { "type": "string", "format": "date" }, "to": { "type": "string", "format": "date" }, "project": { "type": "array", "items": { "type": "string" } } },
  "reloadOn": [], "reloadEvery": "60s" }
```

The OpenAPI document at `/docs/openapi.json` — before, for the Before app's routes; after, for the After app's:

```json
{ "openapi": "3.0.0", "info": { "title": "Hours", "version": "1.0.0" },
  "paths": { "/api/auth": { "get": { "responses": { "200": { "description": "Default Response" } } } } } }
{ "openapi": "3.2.0", "info": { "title": "Hours", "version": "1.0.0" },
  "paths": {
    "/api/auth": { "get": { "responses": { "200": { "description": "Default Response" } } } },
    "/api/report": { "query": {
      "requestBody": { "required": true, "content": { "application/json": { "schema": {
        "type": "object", "additionalProperties": false, "required": ["period"],
        "properties": {
          "period": { "type": "object", "additionalProperties": false, "required": ["from", "to"],
            "properties": { "from": { "type": "string", "format": "date" }, "to": { "type": "string", "format": "date" } } },
          "projects": { "type": "array", "items": { "type": "string" } } } } } } },
      "responses": { "200": { "description": "Default Response" } } } } } }
```

A kind author opts a field into templates (`search/telo.yaml`); the controller receives bindings:

```yaml
kind: Telo.Library
metadata: { name: Search, version: 0.1.0, license: MIT }
lang: en
exports: { kinds: [Criteria] }
---
kind: Telo.Definition
metadata:
  name: Criteria
  description: Search criteria composed from a page's query parameters and sent to a search endpoint.
capability: Telo.Provider
controllers: [pkg:telo/local/js?path=./nodejs/search.mjs&local_path=./nodejs/src/index.ts#CriteriaController]
schema:
  type: object
  additionalProperties: false
  required: [criteria]
  properties:
    criteria:
      type: object
      x-telo-eval: accessor-template
      x-telo-context:
        type: object
        properties:
          query: { x-telo-context-eval: accessor, type: object, additionalProperties: { type: string } }
```

An application using it (`telo.yaml` beside `search/`):

```yaml
kind: Telo.Application
metadata: { name: SearchDemo }
requires: { telo: ">=unreleased" }
lang: en
imports:
  Search: ./search
---
kind: Search.Criteria
metadata: { name: titleSearch }
criteria: { match: { title: !cel "query.q" }, size: 20, tags: [news, !cel "query.tag"] }
```

The controller receives `criteria` as `{ map: { match: { map: { title: { root: "query", path: ["q"] } } }, size: { value: 20 }, tags: { list: [{ value: "news" }, { root: "query", path: ["tag"] }] } } }`; written `{ size: 20 }` alone it receives `{ value: { size: 20 } }`.

## Verify

- The After app sends one `GET /api/auth` for the header and the page together; both show their loading trees (the header's empty), then both draw the same answer.
- `/report?from=2026-11-01&to=2026-11-15&project=acme` sends the `QUERY` shown above, and the heading and list draw the answer; without `project` the body has no `projects`; a literal `null` leaf is sent as `null`; `?to=oops` reads `to` as absent.
- Without `to` the `QUERY` is sent with the partial body and the node draws `failure` over the 400; a `url` resolving to nothing sends nothing and draws `failure` with `ERR_UI_ADDRESS_UNRESOLVED`.
- Changing `from` in the address sends one more `QUERY` and keeps the previous report drawn until it answers; an answer to the earlier body arriving late is not drawn. The report re-reads every minute.
- An action's `refreshes` naming `/api/auth` re-reads the account once; a 401 inside either account node's `children` re-reads it; hiding one account node by `shown` keeps the read, hiding both keeps their children mounted and sends nothing until one is shown, then exactly one read if a trigger arrived meanwhile.
- A body fed by a typed field holds at most one state per mounted node over 1,000 changes; navigating away from the report page aborts its in-flight `QUERY`.
- A same-origin `QUERY` with a session cookie passes the origin check; a cross-origin one from an untrusted origin is `ERR_HTTP_CROSS_ORIGIN_REFUSED`; a cross-origin preflight for `QUERY` succeeds only with `cors.methods` listing it; a `QUERY` route answers on Node.
- The report query with `input.method: POST` and a `POST` route sends the same body and re-reads the same way; a query without `input` sends `GET` and its spec carries `method: "GET"` and `input: null`.
- Each refused case above is refused by `telo check` with the code shown, and the same manifest is refused at load; `kind: Ui.Data` the migration does not match is `UNDEFINED_KIND`.
- The Before app loads with the two `UI_DATA_REPLACED` warnings, and `telo migrate` writes the `web` document shown.
- The `Search.Criteria` controller receives exactly the bindings shown; an `accessor` (not `accessor-template`) field holding `{ a: !cel "row.x" }` is still `ACCESSOR_NOT_PLAIN_CHAIN`; a template leaf rooted at a binding not marked `accessor` is `CEL_UNKNOWN_IDENTIFIER`; `x-telo-match-for` naming a template field is `MATCH_FOR_INVALID`; a union declaring one property `accessor` and `accessor-template` is `EVAL_MODE_BRANCH_CONFLICT` at check and `ERR_EVAL_MODE_BRANCH_CONFLICT` at registration; the binding vector set passes in `ui` and `ui-react`.
- A condition `matches: { format: date }` holds for `2026-11-01` and not for `oops` in the `match.json` vectors.
- The generated documents of the After app, of a server with no `QUERY` route and of a host-restricted server each validate against a pinned copy of the OpenAPI 3.2 schema; a host that cannot reach `/api/report` gets no `query` operation and one that can gets it; `Http.Reference` shows `query /api/report` with its request body.
- The showcase's sign-in gate, rebuilt as an inline query node, re-reads after a 401 inside its children.

## Bookkeeping

- Docs: `ui` `data.md` replaced by `query.md` (the send rule, the id, addresses typed by their grammar and bodies by `input.model`, `POST` when an intermediary refuses `QUERY`, `shown` to draw nothing until a parameter is chosen), `record-contract.md`, `nodes.md` (the `query` node), `action.md` (a read is a `Ui.Query`), `conditions.md` (`format`) and every doc naming a reader; `http-server` route docs (`QUERY`, intermediaries), its authentication and CORS docs (the origin check exempts only `GET`, `HEAD`, `OPTIONS`; cross-origin `QUERY` needs `cors.methods`) and its OpenAPI page (3.2); `http-dispatch`'s matcher docs (`QUERY`); `ui-react` `urls.md` and every `ui-react` doc naming a reader; the accessor-fields guide (`accessor-template`, the two binding forms, `accessor` bindings in scope at it) and the accessor section of the analyzer's guide; `query.md` also states the hold, read and drop rule of a shared read.
- Manifests rewritten by `telo migrate`: `examples/ui-showcase`, `examples/report-console` (and its radix fixture and README), `examples/notes-web`, `examples/approval-workflow`, `examples/feedback-api-repo`, `examples/support-inbox-mcp`, the `ui` tests and fixtures, the `ui-react` data fixture.
- The ui README's kind table and benefits list, the Declarative UI paragraph of `modules/CLAUDE.md`, the root `CLAUDE.md` `x-telo-eval` line, the primer, the hub `build-ui` guide. The ledger's entry on data read when a page is drawn rewritten around queries, reads shared across regions and structured inputs.
- `Added` fragments describing the break and its migration for `ui` and `ui-react`; `Added` for `http-server` (`QUERY`; the document is now 3.2.0, so a reader limited to 3.1 or earlier no longer reads it), for `http-dispatch` (`QUERY` in the matcher's `method`), and for the telo line (`accessor-template`). `telo release floor` with the change.
