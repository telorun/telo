---
status: approved
priority: medium
depends-on: []
packages: [analyzer, modules/ui, modules/ui-react, modules/ui-react-radix, modules/crud, apps/plan-approval, apps/plan-approval-web]
---

# Screens for a review app: page variables, Markdown with annotations, timed reload

## Goal

An application that reviews documents, watches workers or fronts a REST API keyed by ID is declared entirely in `ui`, with no frontend build. plan-approval is the acceptance case: its hand-written React review UI (`apps/plan-approval-web`) is replaced by pages declared in its server manifest. Its `/api/review/` surface is the UI's own backend — agents and runners use `/api/agent/` — so its list routes change to speak the collection contract rather than `ui` growing a second list protocol.

What is missing for that, all generic:

- a page address that carries an ID (`/plans/{id}`), with the `params` root typed from it;
- an authored `markdown` node, with controls on the items the server names;
- a button that runs an action with inputs bound from the data on the page;
- readers and listings that reload on a timer without losing the viewer's place;
- style rules on a `list` node, filter values relative to now, and relative time display;
- one remembered value shared by every form keeping it;
- a collection-contract list over any SELECT, not only over a declared table.

## The example

The plan-approval review screens after this work. It is the review half of the app — the agent API, settings, the webhook relay and the origin guard are left out — and it is referred to by section below.

```yaml
kind: Telo.Application
metadata: { name: PlanApproval, version: 0.2.0 }
lang: en
imports:
  Plans:
    source: ./plans
    resources: { connection: !ref db }
    variables: { longPollCap: 30s }
  SQLite: oci://ghcr.io/telorun/sqlite@0.13.0#sha256-2Q2i3j_3qR2Mcd41LBUO6YuTg_tehWQa4w6Oi5P5-w4
  Http: oci://ghcr.io/telorun/http-server@0.42.0#sha256-wF3AHGL8hGFdy7SfxXJkaXtRzLeqKtgqTVmN9anXKTk
  DataModel: ../../modules/data-model
  Crud: ../../modules/crud
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
variables:
  dbFile: { env: DB_FILE, type: string, x-telo-type: Telo.HostPath, default: plan-approval.sqlite }
targets:
  - !ref Plans.schema
  - !ref server
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
---
# One inbox row.
kind: Telo.JsonSchema
metadata: { name: PlanRow }
schema:
  type: object
  required: [id, title, product, repo, state, revisedAt, overdue]
  properties:
    id: { type: string }
    title: { type: string, title: Plan }
    product: { type: string, title: Product }
    repo: { type: string, title: Repository }
    state:
      type: string
      title: State
      enum: [submitted, changes_requested, revised, approved, rejected, withdrawn, in_progress, completed, parked]
    revisedAt: { type: string, format: date-time, title: Revised }
    overdue: { type: boolean, title: Overdue }
---
# §8: what the inbox route accepts and what its screen offers — one declaration.
kind: DataModel.Collection
metadata: { name: plans }
model: !ref PlanRow
query:
  filters:
    - { property: product, operator: eq }
    - { property: repo, operator: eq }
    - { property: state, operator: in }
    - { property: revisedAt, operator: lte }
  sort: [{ property: revisedAt }]
  facets: [{ property: product }, { property: repo }]
---
kind: Telo.JsonSchema
metadata: { name: RunnerCommand }
schema:
  type: object
  required: [seq, runner, type, state, createdAt]
  properties:
    seq: { type: integer, title: "#" }
    runner: { type: string }
    type: { type: string, title: Command }
    state: { type: string, title: State }
    createdAt: { type: string, format: date-time, title: Created }
---
kind: DataModel.Collection
metadata: { name: commands }
key: seq
model: !ref RunnerCommand
query: { filters: [{ property: state, operator: in }], sort: [{ property: seq }] }
---
# One plan as its page reads it: the latest revision whole, with the items the
# server names in it, and the timeline.
kind: Telo.JsonSchema
metadata: { name: PlanDetail }
schema:
  type: object
  required: [plan, events]
  properties:
    plan:
      type: object
      required: [id, title, state, runner, latestRevision]
      properties:
        id: { type: string }
        title: { type: string }
        state: { type: string }
        runner: { type: [string, "null"] }
        latestRevision:
          type: object
          required: [seq, hash, body, items, createdAt]
          properties:
            seq: { type: integer }
            hash: { type: string }
            body: { type: string }
            createdAt: { type: string, format: date-time }
            items:
              type: array
              items:
                type: object
                required: [id, line, count]
                properties:
                  id: { type: string }
                  line: { type: integer, minimum: 1 }
                  count: { type: integer, minimum: 0 }
    events:
      type: array
      items:
        type: object
        required: [seq, type, author, createdAt]
        properties:
          seq: { type: integer }
          type: { type: string, title: Event }
          author: { type: [string, "null"], title: By }
          createdAt: { type: string, format: date-time, title: When }
---
kind: Telo.JsonSchema
metadata: { name: PlanDiff }
schema:
  type: object
  required: [base, target, comparable, lines, revisions]
  properties:
    base: { type: integer }
    target: { type: integer }
    comparable: { type: boolean }
    lines:
      type: array
      items:
        type: object
        required: [op, text]
        properties:
          op: { type: string, enum: [added, removed, context] }
          text: { type: string }
    # Every revision, marked where it is the base or the target compared.
    revisions:
      type: array
      items:
        type: object
        required: [seq, createdAt, base, target]
        properties:
          seq: { type: integer, title: Revision }
          createdAt: { type: string, format: date-time, title: Revised }
          base: { type: boolean }
          target: { type: boolean }
---
# §4: what a decision sends. `author` and `note` are prompted, so the model
# leaves them optional; the route requires them.
kind: Telo.JsonSchema
metadata: { name: PlanDecision }
schema:
  type: object
  required: [id, decision, revision, hash]
  properties:
    id: { type: string }
    decision: { type: string, enum: [approve, request_changes, reject] }
    revision: { type: integer }
    hash: { type: string }
    author: { type: string, title: Your name, minLength: 1, maxLength: 100 }
    note: { type: string, title: Note, minLength: 1, maxLength: 20000 }
---
kind: Ui.CollectionPresentation
metadata: { name: plansPresentation }
source: { kind: Ui.CollectionSource, collection: !ref plans, basePath: /api/review/plans }
---
kind: Ui.Page
metadata: { name: inbox }
path: /
title: Inbox
children:
  - type: composite
    ref:
      kind: Ui.Filters
      presentation: !ref plansPresentation
      fields:
        - { property: state, operator: in }
        - { property: product, operator: eq, values: present }
        - { property: repo, operator: eq, values: present }
        - { property: revisedAt, operator: lte }
      presets:
        - { label: All, values: [] }
        # §6: re-resolved at every read; the address keeps `now-1day`.
        - label: Waiting a day or more
          values:
            - { property: state, operator: in, value: [submitted, revised] }
            - { property: revisedAt, operator: lte, value: { unit: day, offset: -1 } }
      content:
        type: composite
        ref:
          kind: Ui.Listing
          presentation: !ref plansPresentation
          model: !ref PlanRow
          sort: { by: { property: revisedAt, direction: desc } }
          reloadEvery: 30s
          rowStyle: { by: !cel "row.overdue", cases: { "true": danger } }
          layout:
            kind: Ui.TableLayout
            columns:
              - value: !cel "row.title"
                href: { path: !ref plan, pathParams: { id: !cel "row.id" } }
              - value: !cel "row.product"
              - value: !cel "row.state"
              - value: !cel "row.revisedAt"
---
kind: Ui.Page
metadata: { name: plan }
path: /plans/{id}
title: Plan
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref PlanDetail
      source:
        path: "/api/review/plans/{id}"
        pathParams: { id: !cel "params.id" }
      reloadEvery: 30s
      content:
        type: stack
        children:
          - type: text
            style: heading
            text: { text: "{$title}", values: { title: !cel "data.plan.title" } }
          # §6: "3 hours ago", the exact time on hover.
          - { type: value, value: !cel "data.plan.latestRevision.createdAt", relative: true }
          - type: columns
            children:
              - type: link
                text: Compare revisions
                href: { path: !ref diff, pathParams: { id: !cel "params.id" } }
              # A null `runner` leaves the address unresolved, and a link with an
              # unresolved address is drawn as text.
              - type: link
                text: Its runner
                href: { path: !ref runner, pathParams: { name: !cel "data.plan.runner" } }
          # §4: three buttons, each bound to the revision on screen.
          - type: columns
            children:
              - type: button
                inputs:
                  id: !cel "params.id"
                  decision: approve
                  revision: !cel "data.plan.latestRevision.seq"
                  hash: !cel "data.plan.latestRevision.hash"
                prompt: true
                action:
                  kind: Ui.Action
                  inputModel: !ref PlanDecision
                  request:
                    target: { path: "/api/review/plans/{id}/decisions", pathParams: { id: !cel "input.id" } }
                  label: Approve
                  fields: [author]
                  state: { key: reviewer, store: { kind: Ui.LocalStore }, fields: [author] }
                  onSuccess:
                    refreshes: [{ path: "/api/review/plans/{id}", pathParams: { id: !cel "input.id" } }]
              - type: button
                inputs:
                  id: !cel "params.id"
                  decision: request_changes
                  revision: !cel "data.plan.latestRevision.seq"
                  hash: !cel "data.plan.latestRevision.hash"
                prompt: true
                action:
                  kind: Ui.Action
                  inputModel: !ref PlanDecision
                  request:
                    target: { path: "/api/review/plans/{id}/decisions", pathParams: { id: !cel "input.id" } }
                  label: Request changes
                  fields: [author, note]
                  state: { key: reviewer, store: { kind: Ui.LocalStore }, fields: [author] }
                  onSuccess:
                    refreshes: [{ path: "/api/review/plans/{id}", pathParams: { id: !cel "input.id" } }]
              - type: button
                inputs:
                  id: !cel "params.id"
                  decision: reject
                  revision: !cel "data.plan.latestRevision.seq"
                  hash: !cel "data.plan.latestRevision.hash"
                prompt: true
                confirm: Reject this plan?
                action:
                  kind: Ui.Action
                  inputModel: !ref PlanDecision
                  request:
                    target: { path: "/api/review/plans/{id}/decisions", pathParams: { id: !cel "input.id" } }
                  label: Reject
                  fields: [author, note]
                  state: { key: reviewer, store: { kind: Ui.LocalStore }, fields: [author] }
                  onSuccess:
                    refreshes: [{ path: "/api/review/plans/{id}", pathParams: { id: !cel "input.id" } }]
          # §3: each item the server names gets a Comment control with its count.
          - type: markdown
            text: !cel "data.plan.latestRevision.body"
            annotations:
              rows: !cel "data.plan.latestRevision.items"
              line: !cel "row.line"
              count: !cel "row.count"
              action:
                inputs:
                  id: !cel "params.id"
                  revision: !cel "data.plan.latestRevision.seq"
                  item: !cel "row.id"
                prompt: true
                action:
                  kind: Ui.Action
                  inputModel:
                    kind: Telo.JsonSchema
                    schema:
                      type: object
                      required: [id, revision]
                      properties:
                        id: { type: string }
                        revision: { type: integer }
                        item: { type: string }
                        author: { type: string, title: Your name, minLength: 1, maxLength: 100 }
                        body: { type: string, title: Comment, minLength: 1, maxLength: 20000 }
                  request:
                    target: { path: "/api/review/plans/{id}/comments", pathParams: { id: !cel "input.id" } }
                  label: Comment
                  fields: [author, body]
                  # §7: the same key as the decisions — `author` is entered once.
                  state: { key: reviewer, store: { kind: Ui.LocalStore }, fields: [author] }
                  onSuccess:
                    refreshes: [{ path: "/api/review/plans/{id}", pathParams: { id: !cel "input.id" } }]
          - type: list
            heading: Timeline
            rows: !cel "data.events"
            columns:
              - value: !cel "row.type"
              - value: !cel "row.author"
              - { value: !cel "row.createdAt", relative: true }
---
kind: Ui.Page
metadata: { name: diff }
path: /plans/{id}/diff
title: Changes
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref PlanDiff
      query:
        base: { type: string, pattern: "^[0-9]+$" }
        target: { type: string, pattern: "^[0-9]+$" }
      source:
        path: "/api/review/plans/{id}/diff"
        pathParams: { id: !cel "params.id" }
        queryParams: { base: !cel "query.base", target: !cel "query.target" }
      content:
        type: stack
        children:
          # The server marks what it compared, defaults included.
          - type: list
            heading: Compare from
            rows: !cel "data.revisions"
            rowStyle: { by: !cel "row.base", cases: { "true": strong } }
            columns:
              - value: !cel "row.seq"
                href:
                  path: !ref diff
                  pathParams: { id: !cel "params.id" }
                  queryParams: { base: !cel "row.seq", target: !cel "data.target" }
              - { value: !cel "row.createdAt", relative: true }
          - type: list
            heading: Compare to
            rows: !cel "data.revisions"
            rowStyle: { by: !cel "row.target", cases: { "true": strong } }
            columns:
              - value: !cel "row.seq"
                href:
                  path: !ref diff
                  pathParams: { id: !cel "params.id" }
                  queryParams: { base: !cel "data.base", target: !cel "row.seq" }
              - { value: !cel "row.createdAt", relative: true }
          - type: text
            style: muted
            text: Too large to compare line by line.
            shown: { at: !cel "data.comparable", matches: { const: false } }
          # §5: a line diff as a list with row and column styles.
          - type: list
            rows: !cel "data.lines"
            rowStyle: { by: !cel "row.op", cases: { added: success, removed: danger } }
            columns:
              - value: !cel "row.text"
                style: { by: !cel "row.op", cases: { context: muted } }
---
kind: Ui.Page
metadata: { name: runner }
path: /runners/{name}
title: Runner
children:
  - type: composite
    ref:
      kind: Ui.Listing
      presentation:
        kind: Ui.CollectionPresentation
        source:
          kind: Ui.CollectionSource
          collection: !ref commands
          # §1: a templated base path, filled from the page's variable.
          basePath:
            path: "/api/review/runners/{name}/commands"
            pathParams: { name: !cel "params.name" }
      model: !ref RunnerCommand
      paging: more
      pageSize: 50
      sort: { by: { property: seq, direction: desc }, choosable: false }
      # §2: new commands appear; the second loaded page and the scroll stay.
      reloadEvery: 5s
---
kind: UiReact.App
metadata: { name: ui }
title: Plan approval
theme: !ref UiReact.defaultTheme
pages: [!ref inbox, !ref plan, !ref diff, !ref runner]
navigation:
  items:
    - { type: page, page: !ref inbox }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /api/review, mount: !ref reviewApi }
  - { path: /, mount: !ref ui }
---
kind: Http.Api
metadata: { name: reviewApi }
catches:
  - when: !cel "error.code == 'ERR_PLAN_NOT_FOUND'"
    status: 404
    content: { application/json: { body: { error: !cel "error.message", code: !cel "error.code" } } }
  # §8: a list request the collection does not accept.
  - when: !cel "error.code == 'ERR_CRUD_QUERY_INVALID'"
    status: 400
    content:
      application/problem+json:
        body:
          type: about:blank
          title: Bad Request
          status: 400
          detail: The request is not valid.
          code: !cel "error.code"
          data:
            issues: !cel "error.data.issues.map(i, {'pointer': '/query' + i.pointer, 'keyword': i.keyword, 'params': i.params})"
routes:
  - request: { path: /plans, method: GET }
    handler:
      kind: Crud.Reader
      connection: !ref db
      collection: !ref plans
      # A fixed relation; every filter, the order and the page are the reader's.
      select: !sql |
        SELECT p.id AS id, p.title AS title, p.product AS product, p.repo AS repo,
               p.state AS state, p.latest_at AS revisedAt,
               COALESCE((julianday('now') - julianday(p.latest_at)) * 86400 > pr.deadline_seconds, 0) AS overdue
        FROM plans p JOIN products pr ON pr.slug = p.product
    inputs:
      filters: !cel >-
        keys(request.query)
        .filter(k, !(k in ['limit', 'cursor', 'sort', 'facet']) && !k.startsWith('_telo'))
        .map(k, k.contains('.')
          ? {'property': k.substring(0, k.lastIndexOf('.')), 'operator': k.substring(k.lastIndexOf('.') + 1), 'value': request.query[k]}
          : {'property': k, 'value': request.query[k]})
      sort: !cel >-
        ('sort' in request.query ? request.query.sort.split(',') : [])
        .map(s, {'property': s.startsWith('-') ? s.substring(1) : s, 'direction': s.startsWith('-') ? 'desc' : 'asc'})
      facet: !cel "'facet' in request.query ? request.query.facet : null"
      limit: !cel "'limit' in request.query ? int(request.query.limit) : 25"
      cursor: !cel "'cursor' in request.query ? request.query.cursor : null"
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
  - request:
      path: /plans/{id}
      method: GET
      schema: { params: { type: object, required: [id], properties: { id: { type: string } } } }
    handler: !ref Plans.planDetail
    inputs: { planId: !cel "request.params.id" }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
  - request:
      path: /plans/{id}/diff
      method: GET
      schema:
        params: { type: object, required: [id], properties: { id: { type: string } } }
        query:
          type: object
          properties:
            base: { type: string, pattern: "^[0-9]+$" }
            target: { type: string, pattern: "^[0-9]+$" }
    handler: !ref Plans.planDiff
    inputs:
      planId: !cel "request.params.id"
      base: !cel "has(request.query.base) ? int(request.query.base) : 0"
      target: !cel "has(request.query.target) ? int(request.query.target) : 0"
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
  - request:
      path: /plans/{id}/decisions
      method: POST
      schema:
        params: { type: object, required: [id], properties: { id: { type: string } } }
        body:
          type: object
          additionalProperties: false
          required: [author, decision, revision, hash]
          properties:
            author: { type: string, minLength: 1, maxLength: 100 }
            decision: { type: string, enum: [approve, request_changes, reject] }
            revision: { type: integer, minimum: 1 }
            hash: { type: string, pattern: "^[0-9a-f]{64}$" }
            note: { type: string, minLength: 1, maxLength: 20000 }
          if: { properties: { decision: { const: request_changes } } }
          then: { required: [note] }
    handler: !ref Plans.decidePlan
    inputs:
      planId: !cel "request.params.id"
      author: !cel "request.body.author"
      decision: !cel "request.body.decision"
      revision: !cel "request.body.revision"
      hash: !cel "request.body.hash"
      note: !cel "has(request.body.note) ? request.body.note : ''"
    returns:
      - status: 201
        content: { application/json: { body: !cel "result" } }
  - request:
      path: /plans/{id}/comments
      method: POST
      schema:
        params: { type: object, required: [id], properties: { id: { type: string } } }
        body:
          type: object
          additionalProperties: false
          required: [author, body, revision]
          properties:
            author: { type: string, minLength: 1, maxLength: 100 }
            body: { type: string, minLength: 1, maxLength: 20000 }
            revision: { type: integer, minimum: 1 }
            item: { type: string, pattern: "^[A-Z]+[0-9]+$" }
    handler: !ref Plans.commentPlan
    inputs:
      planId: !cel "request.params.id"
      author: !cel "request.body.author"
      body: !cel "request.body.body"
      revision: !cel "request.body.revision"
      item: !cel "has(request.body.item) ? request.body.item : ''"
    returns:
      - status: 201
        content: { application/json: { body: !cel "result" } }
  - request:
      path: /runners/{name}/commands
      method: GET
      schema: { params: { type: object, required: [name], properties: { name: { type: string } } } }
    handler:
      kind: Crud.Reader
      connection: !ref db
      collection: !ref commands
      select: !sql |
        SELECT seq AS seq, runner AS runner, type AS type, state AS state, created_at AS createdAt
        FROM commands
    inputs:
      # §8: fixed by the route; the client cannot send or widen it.
      scope: { runner: !cel "request.params.name" }
      filters: !cel >-
        keys(request.query)
        .filter(k, !(k in ['limit', 'cursor', 'sort', 'facet']) && !k.startsWith('_telo'))
        .map(k, k.contains('.')
          ? {'property': k.substring(0, k.lastIndexOf('.')), 'operator': k.substring(k.lastIndexOf('.') + 1), 'value': request.query[k]}
          : {'property': k, 'value': request.query[k]})
      sort: !cel >-
        ('sort' in request.query ? request.query.sort.split(',') : [])
        .map(s, {'property': s.startsWith('-') ? s.substring(1) : s, 'direction': s.startsWith('-') ? 'desc' : 'asc'})
      facet: !cel "'facet' in request.query ? request.query.facet : null"
      limit: !cel "'limit' in request.query ? int(request.query.limit) : 25"
      cursor: !cel "'cursor' in request.query ? request.query.cursor : null"
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
```

Before, the same address was a query parameter on a literal page, and the inbox list was a bespoke route with its own parameters:

```yaml
kind: Ui.Page
metadata: { name: plan }
path: /plan
title: Plan
query: { id: { type: string } }
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref PlanDetail
      query: { id: { type: string } }
      source: { path: /api/review/plan-detail, queryParams: { id: !cel "query.id" } }
      content: { type: value, value: !cel "data.plan.title" }
```

```
$ curl -s 'localhost:8080/api/review/plans?status=submitted&age=24h'
{"plans":[{"id":"p7","title":"Split the importer","state":"submitted", …}]}
```

### Refused

Each change below is made to the example above, one at a time.

```
# navigation.items gains { type: page, page: !ref plan }
telo.yaml  error  UiReact.App/ui at 'navigation.items[1]': page plan has a variable in its path
                  (/plans/{id}); reach it with a link whose pathParams fill it  UI_NAVIGATION_PAGE_HAS_PARAMETERS

# the inbox listing's title column links with pathParams: { id: !cel "params.id" }
telo.yaml  error  Ui.Page/inbox: CEL at 'children[0].ref.content.ref.layout.columns[0].href.pathParams.id':
                  'params.id' is not defined on page inbox (path /)  CEL_UNKNOWN_FIELD

# the runner listing's reloadEvery: 1s
telo.yaml  error  Ui.Listing at 'reloadEvery': must be a Telo.Duration at least 5s, not 1s  SCHEMA_VIOLATION

# the plan page's relative value reads data.plan.title
telo.yaml  error  Ui.Page/plan at 'children[0].ref.content.children[1]': relative fits a date
                  or date-time value, not a string  UI_VALUE_RELATIVE_NOT_DATE

# the preset's relative value moves to the state filter
telo.yaml  error  Ui.Filters at 'presets[1].values[0].value': a relative value fits a date or
                  date-time filter with eq, gt, gte, lt or lte, not state with in  UI_FILTER_PRESET_VALUE_INVALID

# the Approve button leaves out hash
telo.yaml  error  Ui.Page/plan at 'children[0].ref.content.children[3].children[0].inputs':
                  required input hash is not bound  CONTRACT_INPUTS_MISMATCH

# the plan page's annotation line reads row.lnie
telo.yaml  error  Ui.Page/plan: CEL at 'children[0].ref.content.children[4].annotations.line':
                  'row.lnie' is not defined (available: id, line, count)  CEL_UNKNOWN_FIELD

# the commands route's scope key is misspelled runnr
telo.yaml  error  Http.Api/reviewApi at 'routes[5].inputs.scope': runnr is not a property of
                  RunnerCommand (seq, runner, type, state, createdAt)  CONTRACT_INPUTS_MISMATCH

# the commands route scopes seq by the runner's name
telo.yaml  error  Http.Api/reviewApi: CEL at 'routes[5].inputs.scope.seq': string is not
                  assignable to integer  CEL_TYPE_ERROR

# a second page with path /plans/{key}
telo.yaml  error  UiReact.App/ui at 'pages[4]': /plans/{key} routes the same addresses as
                  /plans/{id} (pages[1])  UI_PAGE_PATH_DUPLICATE
```

## 1. Page variables

### Page paths

Before: a page `path` is a literal, and `{` in it is text. After: a segment may be `{name}`, standing for exactly one non-empty segment, percent-decoded — the `{name}` syntax `Ui.Address` and `x-telo-path-params-for` already use.

- A segment is either wholly literal or exactly `{name}`; a brace anywhere else, or a repeated name, is `SCHEMA_VIOLATION`.
- A literal segment beats a variable one (`/plans/new` over `/plans/{id}`). Two pages whose paths differ only in variable names route the same addresses and are `UI_PAGE_PATH_DUPLICATE` — the existing rule, now comparing paths with variable segments erased.
- A navigation entry naming a page with a variable is `UI_NAVIGATION_PAGE_HAS_PARAMETERS`, twinned by `ERR_UI_NAVIGATION_PAGE_HAS_PARAMETERS`; a `link` reaches it with an address whose `pathParams` fill its variables, and `Ui.Address`'s existing `PATH_PARAMETER_UNBOUND` / `PATH_PARAMETER_UNUSED` check a `!ref` page path against those entries.
- A malformed encoded segment answers the application's not-found page.
- `UiReact.App` matches a page by segments on the server (the document lookup) and in the browser (which clicks are moves within the application). A move that changes only the query keeps nodes mounted, as today; a move that changes a variable draws the page afresh, since it is another record.

### The `params` root

`params` is a browser root beside `query`: an object holding the page's variables, each a string. It is in scope in every region that binds `query` today — a page's and a reader's trees and `source`, `value`, `list` and `shown`, an action's and a bound action's inputs, a listing's roots and an option source.

- Nothing declares the names it reads. The page's `children` region types `params` with a new generic annotation, `x-telo-context-from-path-template: "<relative pointer>"`, naming the field holding the path template: a closed object with one required string per `{name}`. Every other region types it with `x-telo-context-from-referrer: params`, so a composite, a view or a source placed by a page sees that page's variables, through any chain of references and across an import.
- A read of a variable the placing page lacks is `CEL_UNKNOWN_FIELD`, naming that page as the referrer. Placed by no page, `params` is an open map of strings.
- The annotation's one reader shares the template parser `x-telo-path-params-for` uses. It is analyzer-only: a variable is a string, and a page that routed has every one.

### Templated source paths

`Ui.CollectionSource.basePath` takes `{ path, pathParams }` beside the plain string, `pathParams` reading `params` and `query` (a source has no row). A value that holds nothing at run time sends nothing and draws the node's `failure`.

Invalidation already matches the resolved request path; a templated `basePath` joins it as it resolves, so a write under `/api/review/runners/a/commands` reloads runner `a`'s listing and not runner `b`'s.

Docs: `page.md` (variables, routing, `params`), `nodes.md` (the `params` root), `collection-source.md`, `listing.md`; the annotation in the analyzer guide and the root `CLAUDE.md` annotation list.

**Verify:**
- An inbox row's title links to `/plans/<id>`; that page reads `GET /api/review/plans/<id>`.
- `/plans/new` and `/plans/{id}` both route, the literal winning; the duplicate-path refusal above.
- A `Ui.View` reading `params.id`, placed on `/plans/{id}` and on `/`, is `CEL_UNKNOWN_FIELD` naming the `/` page — the same when the view comes from an imported library.
- The navigation refusal is pinned both ways in `modules/ui/tests/`: refused by `telo check` at the declaring application, and `runFails:` from a consumer `telo check` does not reach.
- Runner `a`'s page reloads on a write under runner `a` and not under runner `b`.

## 2. Timed reload

`reloadEvery` — a duration — on `Ui.Data` and `Ui.Listing`, declared `x-telo-type: { name: Telo.Duration, minimum: 5s }`. Unset, nothing changes. It is a literal: a value below `5s` is refused by the value type's own bound (`SCHEMA_VIOLATION` at check, `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` at creation).

- A tick reloads everything the node reads under the listing's existing reload rule (loaded pages refetched in order, the first page only past ten, records matched by `key`, so focus, open surfaces, expanded state and entered values stay). For a listing that is every group, period and loaded level, and the facet requests over its source.
- A tick is skipped while a read of that node is in flight, and not run while the document is hidden; coming back to visibility runs one read if an interval has passed. A node hidden by `shown` reads nothing.
- A read that fails on a tick keeps what is drawn and shows the node's `failure` beside it, as a failed reload of `Ui.Data` does today; the next tick tries again.
- `Ui.Data` keeps its content mounted, as it does for `reloadOn`.

Docs: `data.md`, `listing.md`.

**Verify:**
- The runner page with two loaded pages of commands shows a new command within one interval, still on its second page, scroll position unchanged.
- An open prompt keeps its entered values across a tick.
- A hidden tab makes no request; showing it makes one. A tick during a slow read makes no second request.
- `reloadEvery: 1s` is refused at check and at creation.

## 3. Markdown with annotations

The wire `markdown` node and its renderer already ship (`ui-react`'s Markdown chunk: CommonMark with GFM, raw HTML drawn as text, links and images held to the address rule, code highlighted). What a page cannot do is write one.

`Ui.Node` gains `{ type: markdown, text, annotations?, style?, shown? }`, the authoring twin of the wire node: `text` is an accessor to a string, resolved to the wire node's binding.

**Annotations** are items the server names. `annotations` is `{ rows, line, count?, action }`, on both the authored and the wire node:

- `rows` is an accessor to a list; each element is `row` (`x-telo-context-element-from-item: "0/rows"`). Which blocks are items, and their IDs, are the server's grammar; the node parses none.
- `line` is an accessor over `row` to the 1-based source line that starts the item; `count` an optional accessor to an integer shown on the control as a `badge`.
- `action` is a `Ui.BoundAction` (§4) whose region binds `row` beside the roots in scope. Its control reads the action's `label`.
- The control is drawn on the block containing `line` (a list item for an item line, a heading for a heading line); two annotations on one block draw two controls in order. An annotation whose line is past the text is drawn after the text with its control, so nothing is lost silently.

The part list's `markdown` group gains `markdown-annotations` (the element inside a block holding its controls), `markdown-annotation` (one control: the `row-action` button, the `badge` with the count, and the `row-answer` / `row-failure` of a press) and `markdown-unplaced-annotations` (the area after the text), styled by the default theme and by `ui-react-radix`. `ui_react_controls-3` is unchanged.

Docs: `nodes.md` (the authored node, annotations), `modules/ui-react/docs/markdown.md` (placement).

**Verify:**
- The plan page shows the latest revision's body; each item has a Comment control with its count; pressing one opens the prompt with `author` and `body`, and sends `item` set to the item's ID.
- An item inside a fenced block gets no control, because the server names none there.
- An annotation naming line 999 of a ten-line text is drawn after it.
- `row.lnie` in `line` is `CEL_UNKNOWN_FIELD`; renderer tests pin the placement.

## 4. A button bound to page data

Before: a `Ui.Action` placed on a page takes its input from its own form only, so it cannot send the ID in the path or the revision a reader read; only a row of a listing or a `list` can bind inputs, through `Ui.RowAction`.

After: the entry shape is renamed `Ui.BoundAction` (`{ action, inputs, confirm?, prompt?, enabled? }`, its twin `ERR_UI_BOUND_ACTION_INPUTS_INVALID`), since it now has uses with no row, and a `button` node runs one over the roots in scope:

- `{ type: button, action, inputs, confirm?, prompt?, enabled?, button?, style?, shown? }`. `inputs` reads `params`, `query` and the roots of the tree the button sits in (`data` in a reader), and is judged against the action's `inputModel` as a row action's is, with the same codes. `button` is a `Ui.ButtonDisplay`, as on `link`. The button reads the action's `label`.
- It draws as a row action does: the answer in place of the button, the `failure` beside it (or in the open prompt), no press while one is pending.
- `rowActions` on a listing and a `list`, and `annotations.action`, keep their keys and take `Ui.BoundAction`.
- A prompted field is one the input model leaves optional, as for row actions today; a route that requires it answers a 400 the prompt shows on that field. The decisions route requires `note` for `request_changes` with `if` / `then` in its body schema.

Docs: `nodes.md` (the `button` node), `action.md` and `listing.md` (the renamed shape).

**Verify:**
- Approve sends `POST /api/review/plans/p7/decisions` with `{ author, decision: approve, revision, hash }`, and the plan reader reloads.
- Request changes with an empty note shows the 400 on `note` in its prompt.
- A stale revision draws the `ERR_REVISION_SUPERSEDED` failure beside its button.
- `data.plan.latestRevison.seq` is `CEL_UNKNOWN_FIELD`; the unbound-input refusal above.

## 5. Style rules on `list`

A `list` node takes `rowStyle`, and a column takes `style`, each a style rule over `row`, as a listing's do. Docs: `nodes.md`.

**Verify:** the diff page draws added lines `success`, removed lines `danger` and context lines `muted`, and the compared revisions `strong`; a `by` that is not a plain chain is `ACCESSOR_NOT_PLAIN_CHAIN`.

## 6. Relative values

### In filters

A `date` or `date-time` filter's `default` and a preset's value may be `{ unit: minute | hour | day | week | month | year, offset }`: now moved by `offset` units in the viewer's time zone — the instant for a `date-time`, that moment's date for a `date`. Legal with `eq`, `gt`, `gte`, `lt`, `lte`; not with `in`.

- A value from a relative default or preset stays relative while the viewer leaves it: the active preset is still read off the bar's values, the address and the store keep the spelling `now<±n><unit>` (`now-1day`), and the value is resolved when a listing reads its first page. Every later page of that sequence, and every page of one reload cycle, sends the same resolved value, since the next page's cursor was issued for it; the next first-page read, a reload cycle or a filter change resolves it again.
- Typing a value replaces it with an absolute one.
- A relative value on another property type, or with `in`, is `UI_FILTER_DEFAULT_INVALID` / `UI_FILTER_PRESET_VALUE_INVALID`, the codes the other defaults use.

**Verify:** the inbox preset "Waiting a day or more" sends `revisedAt.lte=<now − 1 day>`; loading a second page minutes later sends the same instant and is answered, not refused for its cursor; a tick resolves it again; the same link a day later asks relative to that day; the preset stays active after a reload; the address reads `now-1day`.

### Relative time display

`value` and a `list` column take `relative: true`: a `date-time` (or `date`) is drawn as relative time in the viewer's language ("3 hours ago"), with the exact time as its tooltip and the element's machine-readable time, refreshed every minute while on screen. On any other type it is `UI_VALUE_RELATIVE_NOT_DATE`, twinned by `ERR_UI_VALUE_RELATIVE_NOT_DATE`.

**Verify:** a `date-time` three hours back reads "3 hours ago", the exact time on hover.

Docs: `filters.md`, `nodes.md`.

## 7. One remembered value across forms

Before: entries sharing a `state` key read the store and the address once, when they mount, and a write replaces the whole stored entry with the writer's own `fields`. So `author` entered in one prompt is not seen by an entry already mounted, and a narrower entry's write erases a wider one's other properties.

After, as "one key is one state" already documents: entries sharing a `state` key and store hold each kept property as one value. A store write merges property by property, and every entry mounted in the document follows a change another entry makes to a property it keeps, from the address and the store alike. Another tab sees it at its next mount.

Docs: `field-kinds.md` (kept values).

**Verify:** renderer tests — `author` entered in a Comment prompt prefills the Approve prompt; a narrower entry's write keeps a wider entry's other kept property.

## 8. Lists over any SELECT, and plan-approval

### `Crud.Reader`

Before: `Crud.Reader` serves the collection contract — the declared filter, sort and facet pairs, `limit` 1–100, the opaque cursor, `{ rows, total, next }`, `ERR_CRUD_QUERY_INVALID` with `issues` — but only inside `Crud.Api`, over one declared table. A hand-written list with joined or computed columns has to rebuild all of it.

After: `crud` exports `Crud.Reader`, which takes:

- `connection`, and `collection` — a `DataModel.Collection`, whose `model` and `query` say what a row holds and what is accepted. The reader's `row` and `query` stay as optional overrides defaulting from it, which `Crud.Api` keeps using (its lister's `row` is the collection's list shape, its by-id reader's `query` the key filter); its own `model` is replaced by the collection's;
- either `table` (as today) or `select`: one fixed `!sql` SELECT whose columns are aliased to the model's property names. The reader wraps it as a subquery and renders every filter, the order, the seek, the limit, the count and the facet grouping through the connection's dialect, with every value bound;
- a `scope` input beside the existing ones: model property → value, equalities the route fixes, which no client can send or widen. A client filter on a scoped property is `ERR_CRUD_QUERY_INVALID`.

`scope` is typed by the existing member form of `x-telo-value-schema-from` (`{ from: /collection/model, member: "0#" }` on the map's values), whose one reader is corrected in two ways, in the contract and the configuration positions alike:

- the member types go on the map node, so each value is held to the model property its key names — today the conjunct sits on each value and checks a scalar against nothing;
- a key naming no property of the reached type is refused — today it contributes nothing. A key the kind's own schema fixes keeps today's reading.

Refusals use the existing codes: `CONTRACT_INPUTS_MISMATCH` for a literal key at a call site, `CEL_TYPE_ERROR` for a value expression, `SCHEMA_VIOLATION` at a configuration slot, `ERR_INPUT_INVALID` for a computed `scope` at dispatch. The member form's other users, `Ui.Listing.filters` and `Ui.CollectionOptions.filters`, then refuse an unknown key through it, so their `UI_SOURCE_FILTER_UNKNOWN_PROPERTY` resource rules are deleted; the controllers' run-time refusals stay.

Docs: `modules/crud/docs/` (the reader, `select`, `scope`); the annotation entry in the analyzer guide, the root `CLAUDE.md` bullet and `kernel/specs/invocation-contract.md`; `listing.md` and `field-kinds.md` in `ui`.

`Crud.Api` forwards its collection to the reader; its behaviour is unchanged.

**Verify:** `crud`'s list, declared-query and facet tests pass unchanged; the two `scope` refusals above; `scope: !cel "{'runnr': request.params.name}"` passes check and fails at dispatch with `ERR_INPUT_INVALID`, a row in `tests/check-run-agreement.yaml`; `ui`'s listing and option-source tests still refuse an unknown filter key, now as `SCHEMA_VIOLATION`; runner `a`'s commands never include runner `b`'s, and `?runner=b` is a 400.

### plan-approval

The review API changes; the agent API does not.

- **Lists** — plans, products, repos, runners, a runner's sessions and its commands — are `Crud.Reader`s over fixed SELECTs, each over a declared `DataModel.Collection` the screen's `Ui.CollectionSource` names too. Plans gain `revisedAt`, the latest revision's time, and lose `age`; a runner's sessions and commands are scoped by `scope`, and an unknown runner answers an empty page.
- **A revision's items** become `{ id, line, count }`: `line` found at read by the server's item parser in the stored body (so stored revisions need no backfill), `count` the comments on that item in that revision. `plan.latestRevision` carries `body`.
- **`GET /plans/{id}/diff?base=&target=`** answers `{ base, target, comparable, lines: [{ op, text }], revisions }`, computed by `TextDiff.LineDiff` (bounded by its byte limit, `comparable: false` beyond it); `revisions` marks the two compared. Omitted, `base` is `lastReviewedRevision` and `target` the latest.
- **Both history exports** answer with `Content-Disposition: attachment` (`plan-<id>-history.json`, `product-<slug>-history.json`), so a `link` node downloads them and the page stays.
- **Settings** are `Ui.Listing`s over products and repos (create a `POST`, edit a `PUT` that replaces); a product's deliveries a `list` in a `Ui.Data`.
- `apps/plan-approval-web`, the `UI_DIR` variable, the `Http.Static` mount and the UI build in Docker Compose are deleted; `UiReact.App` is mounted at `/`.
- The app's tests, `demo/` and the README's review-API table move to the new routes.

```
$ curl -s 'localhost:8080/api/review/plans?state.in=submitted&state.in=revised&revisedAt.lte=2026-11-06T09:00:00Z&sort=-revisedAt&limit=2'
{"rows":[{"id":"p7","title":"Split the importer","product":"telo","repo":"telo","state":"revised","revisedAt":"2026-11-05T16:20:00Z","overdue":true},
        {"id":"p4","title":"Cache warm on boot","product":"telo","repo":"hub","state":"submitted","revisedAt":"2026-11-04T08:02:11Z","overdue":false}],
 "total":5,"next":"cDQ"}

$ curl -s 'localhost:8080/api/review/plans?facet=product'
{"values":[{"value":"telo","count":9},{"value":"hub","count":3}],"next":null}

$ curl -s 'localhost:8080/api/review/plans?age=24h'
{"type":"about:blank","title":"Bad Request","status":400,"detail":"The request is not valid.","code":"ERR_CRUD_QUERY_INVALID",
 "data":{"issues":[{"pointer":"/query/age","keyword":"invalid","params":{}}]}}

$ curl -s 'localhost:8080/api/review/plans/p7' | jq '.plan.latestRevision.items'
[{"id":"S1","line":3,"count":2},{"id":"S2","line":9,"count":0}]

$ curl -s 'localhost:8080/api/review/plans/p7/diff'
{"base":1,"target":3,"comparable":true,
 "lines":[{"op":"context","text":"## S1 Split"},{"op":"removed","text":"- one file"},{"op":"added","text":"- two files"}],
 "revisions":[{"seq":1,"createdAt":"2026-11-01T10:00:00Z","base":true,"target":false},
              {"seq":2,"createdAt":"2026-11-03T12:30:00Z","base":false,"target":false},
              {"seq":3,"createdAt":"2026-11-05T16:20:00Z","base":false,"target":true}]}

$ curl -sI 'localhost:8080/api/review/plans/p7/history' | grep -i disposition
content-disposition: attachment; filename="plan-p7-history.json"
```

**Verify:** the inbox, plan page (Markdown, annotations, decisions, comments, timeline), diff, settings and runner pages each load against the new routes; the plans SELECT has no clause built from the request; the app's own tests pass; `pnpm run telo apps/plan-approval/telo.yaml` starts it with no frontend build.

An `examples/ui-showcase` page set exercises the `ui` features against its fixture server, with a test under its own `tests/` run by `examples/test-suite.yaml`.

## 9. Docs, guides, ledger

- `modules/ui/README.md` and the docs named above; `modules/ui-react/` docs for the renderer parts; `modules/crud/` docs and README for the exported reader.
- `apps/hub/guides/build-ui.md` and `apps/authoring-agent/chat/primer.md`: page variables and `params`, `reloadEvery`, the `markdown` node and annotations, the `button` node and `Ui.BoundAction`, `list` styles, relative values, `relative`, `Crud.Reader` over a SELECT with `scope`, and a member-form map refusing a key the model does not declare.
- `docs/guides/what-you-get.md`, under Standard library: "Routes keyed by ID" (page paths with variables, refused before the app runs when a page lacks a variable a screen reads); "Screens that reload in place" (`reloadEvery` keeps loaded pages, scroll and open forms); "Markdown with review controls" (items the server names get controls; raw HTML is never inserted); the list-endpoint entry extended to any SELECT — filtered, sorted, cursor-paged, with totals and facets, and scoped by the route.
- `modules/CLAUDE.md`: the Declarative UI paragraph gains page variables and `params`, templated `basePath`, the authored `markdown` node with annotations, the `button` node and `Ui.BoundAction`, and `reloadEvery`; the CRUD paragraph gains the exported reader.

## Releases

One fragment per module, written with `telo release add`, each body naming only its own module:

| Module | Kind | What the body says |
| --- | --- | --- |
| `ui` | `Added`, describing the break | page path variables (a brace in a page path is now a variable), the `params` root, templated `basePath`, `reloadEvery`, the authored `markdown` node with annotations, the `button` node, `Ui.RowAction` renamed `Ui.BoundAction`, `list` styles, relative filter values, `relative` |
| `ui-react` | `Added` | segment routing, annotation placement, the `button` node, timed reload, shared kept values, relative time |
| `ui-react-radix` | `Added` | styles for the annotation control |
| `crud` | `Added`, describing the break | `Crud.Reader` exported, reading a `DataModel.Collection` over a table or a fixed SELECT, with `scope` |

A changeset on the telo line names `@telorun/analyzer` for `x-telo-context-from-path-template` and the corrected member form of `x-telo-value-schema-from`, and one goes on `@telorun/ui-react-contract` for the part list. The `ui` body also says an unknown filter key is now `SCHEMA_VIOLATION`.

**`requires:` floors:** `crud` gets one only if the previous published CLI rejects it with the block stripped. `ui` declares `x-telo-context-from-path-template` in its own schemas, so it gets `requires: telo: ">=<the release carrying it>"` if running the previous published CLI against `ui` with the block stripped rejects it; restoring the block must then give `MODULE_REQUIRES_NEWER_RUNTIME`. No other module gets one unless the same test shows it.
