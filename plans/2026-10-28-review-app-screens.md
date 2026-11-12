---
status: done
priority: medium
depends-on: []
packages: [analyzer, kernel, packages/ide-support, modules/ui, modules/ui-react, modules/ui-react-radix, modules/crud, modules/http-server, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
tracking: feat/review-app-screens
---

# Screens for a review app: page variables, Markdown with annotations, timed reload

## Goal

An application that reviews documents, watches workers or fronts a REST API keyed by ID is declared entirely in `ui`, with no frontend build. The acceptance case is a document-review page set in `examples/ui-showcase` — an inbox, a document page, a compare page and a worker page. Its review API speaks the collection contract for its lists, so `ui` gains no second list protocol.

What is missing for that, all generic:

- a page address that carries an ID (`/reviews/{id}`), with the `params` root typed from it;
- an authored `markdown` node, with controls on the items the server names;
- a button that runs an action with inputs bound from the data on the page;
- readers and listings that reload on a timer without losing the viewer's place;
- style rules on a `list` node, filter values relative to now, and a `time` node drawing a date relative to now;
- one remembered value shared by every form keeping it;
- a collection-contract list over any SELECT, not only over a declared table.

## The example

The showcase's review pages after this work: `examples/ui-showcase/pages-review.yaml`, a partial the showcase's `telo.yaml` includes and whose four pages every one of its applications lists, the inbox in the navigation. Its collections live in `data.yaml` beside the review tables, and its routes in `api.yaml` as the router `reviewApi`, mounted at `/api/review`. It is referred to by section below; each page also opens with a muted line saying what it shows, left out here.

`pages-review.yaml`:

```yaml
kind: Ui.Page
metadata: { name: inbox }
path: /reviews
title: Reviews
children:
  - type: composite
    ref:
      kind: Ui.Filters
      presentation: !ref reviewsPresentation
      fields:
        - { property: state, operator: in }
        - { property: product, operator: eq, values: present }
        - { property: repo, operator: eq, values: present }
        - { property: revisedAt, operator: lte }
      presets:
        - { label: All, values: [] }
        # §6: resolved at every read; the address keeps `now-1day`.
        - label: Waiting a day or more
          values:
            - { property: state, operator: in, value: [submitted, revised] }
            - { property: revisedAt, operator: lte, value: { unit: day, offset: -1 } }
      content:
        type: composite
        ref:
          kind: Ui.Listing
          presentation: !ref reviewsPresentation
          model: !ref ReviewRow
          sort: { by: { property: revisedAt, direction: descending } }
          reloadEvery: 30s
          rowStyle: { by: !cel "row.overdue", cases: { "true": danger } }
          layout:
            kind: Ui.TableLayout
            columns:
              - value: !cel "row.title"
                href: { path: !ref review, pathParams: { id: !cel "row.id" } }
              - value: !cel "row.product"
              - value: !cel "row.state"
              - value: !cel "row.revisedAt"
---
kind: Ui.Page
metadata: { name: review }
path: /reviews/{id}
title: Review
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref ReviewDetail
      source:
        path: "/api/review/reviews/{id}"
        pathParams: { id: !cel "params.id" }
      reloadEvery: 30s
      content:
        type: stack
        children:
          - type: text
            style: heading
            text: { text: "{$title}", values: { title: !cel "data.review.title" } }
          # §6: "3 hours ago", the exact time on hover.
          - { type: time, value: !cel "data.review.latestRevision.createdAt", relative: true }
          - type: columns
            children:
              - type: link
                text: Compare revisions
                href: { path: !ref compare, pathParams: { id: !cel "params.id" } }
              # With no worker the parameter is null, which leaves the address
              # unresolved, and a link with an unresolved address is drawn as text.
              - type: link
                text: Its worker
                href: { path: !ref worker, pathParams: { name: !cel "data.review.worker" } }
          # §4: three buttons, each bound to the revision on screen.
          - type: columns
            children:
              - type: button
                inputs:
                  id: !cel "params.id"
                  decision: approve
                  revision: !cel "data.review.latestRevision.seq"
                  hash: !cel "data.review.latestRevision.hash"
                prompt: true
                action:
                  kind: Ui.Action
                  inputModel: !ref ReviewDecision
                  outputModel: !ref ReviewDecisionAnswer
                  request:
                    target: { path: "/api/review/reviews/{id}/decisions", pathParams: { id: !cel "input.id" } }
                  label: Approve
                  # The prompt asks for `author`, the one field the inputs leave.
                  fields: [id, decision, revision, hash, author]
                  state: { key: reviewer, store: { kind: Ui.LocalStore }, fields: [author] }
                  onSuccess:
                    refreshes: [{ path: "/api/review/reviews/{id}", pathParams: { id: !cel "input.id" } }]
              - type: button
                inputs:
                  id: !cel "params.id"
                  decision: request_changes
                  revision: !cel "data.review.latestRevision.seq"
                  hash: !cel "data.review.latestRevision.hash"
                prompt: true
                action:
                  kind: Ui.Action
                  inputModel: !ref ReviewDecision
                  outputModel: !ref ReviewDecisionAnswer
                  request:
                    target: { path: "/api/review/reviews/{id}/decisions", pathParams: { id: !cel "input.id" } }
                  label: Request changes
                  state: { key: reviewer, store: { kind: Ui.LocalStore }, fields: [author] }
                  onSuccess:
                    refreshes: [{ path: "/api/review/reviews/{id}", pathParams: { id: !cel "input.id" } }]
              - type: button
                inputs:
                  id: !cel "params.id"
                  decision: reject
                  revision: !cel "data.review.latestRevision.seq"
                  hash: !cel "data.review.latestRevision.hash"
                prompt: true
                confirm: Reject this document?
                action:
                  kind: Ui.Action
                  inputModel: !ref ReviewDecision
                  outputModel: !ref ReviewDecisionAnswer
                  request:
                    target: { path: "/api/review/reviews/{id}/decisions", pathParams: { id: !cel "input.id" } }
                  label: Reject
                  state: { key: reviewer, store: { kind: Ui.LocalStore }, fields: [author] }
                  onSuccess:
                    refreshes: [{ path: "/api/review/reviews/{id}", pathParams: { id: !cel "input.id" } }]
          # §3: each item the server names gets a Comment control with its count.
          - type: markdown
            value: !cel "data.review.latestRevision.body"
            annotations:
              rows: !cel "data.review.latestRevision.items"
              line: !cel "row.line"
              count: !cel "row.count"
              action:
                inputs:
                  id: !cel "params.id"
                  revision: !cel "data.review.latestRevision.seq"
                  item: !cel "row.id"
                prompt: true
                action:
                  kind: Ui.Action
                  inputModel:
                    kind: Telo.JsonSchema
                    schema:
                      type: object
                      additionalProperties: false
                      required: [id, revision, author, body]
                      properties:
                        id: { type: string }
                        revision: { type: integer }
                        item: { type: string }
                        author: { type: string, title: Your name, minLength: 1, maxLength: 100 }
                        body: { type: string, title: Comment, minLength: 1, maxLength: 20000 }
                  outputModel: !ref ReviewCommentAnswer
                  request:
                    target: { path: "/api/review/reviews/{id}/comments", pathParams: { id: !cel "input.id" } }
                  label: Comment
                  # §7: the same key as the decisions — `author` is entered once.
                  state: { key: reviewer, store: { kind: Ui.LocalStore }, fields: [author] }
                  onSuccess:
                    refreshes: [{ path: "/api/review/reviews/{id}", pathParams: { id: !cel "input.id" } }]
          - type: list
            heading: Timeline
            rows: !cel "data.events"
            columns:
              - value: !cel "row.type"
              - value: !cel "row.author"
              - { type: time, value: !cel "row.createdAt", relative: true }
---
kind: Ui.Page
metadata: { name: compare }
path: /reviews/{id}/compare
title: Changes
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref ReviewComparison
      query:
        base: { type: string, pattern: "^[0-9]{1,9}$" }
        target: { type: string, pattern: "^[0-9]{1,9}$" }
      source:
        path: "/api/review/reviews/{id}/compare"
        pathParams: { id: !cel "params.id" }
        queryParams: { base: !cel "query.base", target: !cel "query.target" }
      content:
        type: stack
        children:
          # The server marks what it compared, its defaults included.
          - type: list
            heading: Compare from
            rows: !cel "data.revisions"
            rowStyle: { by: !cel "row.base", cases: { "true": strong } }
            columns:
              - value: !cel "row.seq"
                href:
                  path: !ref compare
                  pathParams: { id: !cel "params.id" }
                  queryParams: { base: !cel "row.seq", target: !cel "data.target" }
              - { type: time, value: !cel "row.createdAt", relative: true }
          - type: list
            heading: Compare to
            rows: !cel "data.revisions"
            rowStyle: { by: !cel "row.target", cases: { "true": strong } }
            columns:
              - value: !cel "row.seq"
                href:
                  path: !ref compare
                  pathParams: { id: !cel "params.id" }
                  queryParams: { base: !cel "data.base", target: !cel "row.seq" }
              - { type: time, value: !cel "row.createdAt", relative: true }
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
metadata: { name: worker }
path: /workers/{name}
title: Worker
children:
  - type: text
    style: heading
    text: { text: "Worker {$name}", values: { name: !cel "params.name" } }
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
            path: "/api/review/workers/{name}/commands"
            pathParams: { name: !cel "params.name" }
      model: !ref WorkerCommand
      paging: more
      pageSize: 50
      sort: { by: { property: seq, direction: descending }, choosable: false }
      # §2: new commands appear; the second loaded page and the scroll stay.
      reloadEvery: 5s
```

`data.yaml`, beside the review tables (`review_products`, `reviews`, `review_revisions`, `review_items`, `review_comments`, `review_events`, `worker_commands`), each seeded:

```yaml
# One inbox row: the latest revision's time, and whether the review has waited
# past its product's deadline for a decision.
kind: Telo.JsonSchema
metadata: { name: ReviewRow }
schema:
  type: object
  required: [id, title, product, repo, state, revisedAt, overdue]
  properties:
    id: { type: string }
    title: { type: string, title: Document }
    product: { type: string, title: Product }
    repo: { type: string, title: Repository }
    state:
      type: string
      title: State
      enum: [submitted, changes_requested, revised, approved, rejected]
      oneOf:
        - { const: submitted, title: Submitted }
        - { const: changes_requested, title: Changes requested }
        - { const: revised, title: Revised }
        - { const: approved, title: Approved }
        - { const: rejected, title: Rejected }
    revisedAt: { type: string, format: date-time, title: Revised }
    overdue: { type: boolean, title: Overdue }
---
# §8: what the inbox route accepts and what its screen offers — one declaration.
kind: DataModel.Collection
metadata: { name: reviews }
model: !ref ReviewRow
query:
  filters:
    - { property: product, operator: eq }
    - { property: repo, operator: eq }
    - { property: state, operator: in }
    - { property: revisedAt, operator: lte }
  sort: [{ property: revisedAt }]
  facets: [{ property: product }, { property: repo }]
---
kind: Ui.CollectionPresentation
metadata: { name: reviewsPresentation }
source: { kind: Ui.CollectionSource, collection: !ref reviews, basePath: /api/review/reviews }
---
kind: Telo.JsonSchema
metadata: { name: WorkerCommand }
schema:
  type: object
  required: [seq, worker, type, state, createdAt]
  properties:
    seq: { type: integer, title: "#" }
    worker: { type: string, title: Worker }
    type: { type: string, title: Command }
    state: { type: string, title: State }
    createdAt: { type: string, format: date-time, title: Created }
---
kind: DataModel.Collection
metadata: { name: commands }
key: seq
model: !ref WorkerCommand
query: { filters: [{ property: state, operator: in }], sort: [{ property: seq }] }
```

`api.yaml`: the shapes the pages read, and the router. `ReviewDetail` is `{ review: { id, title, state, worker, latestRevision: { seq, hash, body, createdAt, items: [{ id, line, count }] } }, events: [{ seq, type, author, createdAt }] }`, `worker` empty when no worker writes the document; `ReviewComparison` is `{ base, target, comparable, lines: [{ op, text }], revisions: [{ seq, createdAt, base, target }] }`; `ReviewDecisionAnswer` is `{ id, decision, state, revision }` and `ReviewCommentAnswer` `{ id, revision, item, count }`.

```yaml
# §4: what a decision sends. `author` and `note` are entered in the prompt; the
# route's body schema requires `note` for `request_changes`.
kind: Telo.JsonSchema
metadata: { name: ReviewDecision }
schema:
  type: object
  additionalProperties: false
  required: [id, decision, revision, hash, author]
  properties:
    id: { type: string }
    decision: { type: string, enum: [approve, request_changes, reject] }
    revision: { type: integer }
    hash: { type: string }
    author: { type: string, title: Your name, minLength: 1, maxLength: 100 }
    note: { type: string, title: Note, minLength: 1, maxLength: 20000 }
---
kind: Http.Api
metadata: { name: reviewApi }
catches:
  # §8: a list request the collection does not accept.
  - when: !cel "problem.code == 'ERR_CRUD_QUERY_INVALID'"
    status: 400
    content:
      application/problem+json:
        body:
          type: !cel "problem.type"
          title: !cel "problem.title"
          status: !cel "problem.status"
          detail: !cel "problem.detail"
          code: !cel "problem.code"
          data:
            issues: !cel "problem.data == null ? [] : problem.data.issues.map(i, {'pointer': '/query' + i.pointer, 'keyword': i.keyword, 'params': i.params})"
  - when: !cel "problem.code == 'ERR_REVIEW_NOT_FOUND' || problem.code == 'ERR_REVISION_NOT_FOUND' || problem.code == 'ERR_ITEM_NOT_FOUND'"
    status: 404
    content: { application/problem+json: {} }
  - when: !cel "problem.code == 'ERR_REVISION_SUPERSEDED'"
    status: 409
    content: { application/problem+json: {} }
routes:
  - request:
      method: GET
      path: /reviews
      schema:
        query: &listQuery
          type: object
          additionalProperties: true
          properties:
            limit: { type: integer, minimum: 1, maximum: 100, default: 25 }
            cursor: { type: string }
            sort: { type: string }
            facet: { type: string }
    inputs:
      filters: &listFilters !cel >-
        keys(request.query)
        .filter(k, !(k in ['limit', 'cursor', 'sort', 'facet']))
        .map(k, k.contains('.')
          ? {'property': k.substring(0, k.lastIndexOf('.')), 'operator': k.substring(k.lastIndexOf('.') + 1), 'value': request.query[k]}
          : {'property': k, 'value': request.query[k]})
      sort: &listSort !cel >-
        ('sort' in request.query ? request.query.sort.split(',') : [])
        .map(s, {'property': s.startsWith('-') ? s.substring(1) : s, 'direction': s.startsWith('-') ? 'desc' : 'asc'})
      facet: &listFacet !cel "'facet' in request.query ? request.query.facet : null"
      limit: &listLimit !cel "request.query.limit"
      cursor: &listCursor !cel "'cursor' in request.query ? request.query.cursor : null"
    handler:
      kind: Crud.Reader
      connection: !ref db
      collection: !ref reviews
      # A fixed relation; every filter, the order and the page are the reader's.
      select: !sql |
        SELECT r.id AS id, r.title AS title, r.product AS product, r.repo AS repo, r.state AS state,
               v.created_at AS revisedAt,
               (r.state IN ('submitted', 'revised')
                 AND (julianday('now') - julianday(v.created_at)) * 86400 > p.deadline_seconds) AS overdue
        FROM reviews r
        JOIN review_products p ON p.slug = r.product
        JOIN review_revisions v ON v.review_id = r.id
          AND v.seq = (SELECT MAX(seq) FROM review_revisions WHERE review_id = r.id)
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
  # GET /reviews/{id}: a `Telo.Sequence` of `Sql.Query` steps answering
  # `ReviewDetail` — the review (else ERR_REVIEW_NOT_FOUND), its latest revision,
  # that revision's stored items each with its comment count, its events.
  - request:
      method: GET
      path: /reviews/{id}/compare
      schema:
        params: { type: object, required: [id], properties: { id: { type: string } } }
        query:
          type: object
          additionalProperties: false
          properties:
            base: { type: string, pattern: "^[0-9]{1,9}$" }
            target: { type: string, pattern: "^[0-9]{1,9}$" }
    inputs:
      id: !cel "request.params.id"
      base: !cel "has(request.query.base) ? int(request.query.base) : 0"
      target: !cel "has(request.query.target) ? int(request.query.target) : 0"
    handler:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [id, base, target]
          properties: { id: { type: string }, base: { type: integer }, target: { type: integer } }
      outputType: !ref ReviewComparison
      # Steps: the review's `last_reviewed` (else ERR_REVIEW_NOT_FOUND) and every
      # revision; `chosen` — `base` defaulting to the revision last decided on
      # (the first when none was), `target` to the latest; ERR_REVISION_NOT_FOUND
      # for a chosen revision that does not exist.
      steps: […]
      outputs: !cel >-
        cel.bind(rows, steps.revisions.result.rows, cel.bind(c, steps.chosen.result,
        cel.bind(d, TextDiff.lineDiff(rows.filter(r, r.seq == c.base)[0].body, rows.filter(r, r.seq == c.target)[0].body), {
          'base': c.base, 'target': c.target, 'comparable': d.comparable,
          'lines': d.hunks == null ? [] : flatten(d.hunks.map(h, h.lines)).map(l, {'op': l.op, 'text': l.text}),
          'revisions': rows.map(r, {'seq': r.seq, 'createdAt': r.created_at, 'base': r.seq == c.base, 'target': r.seq == c.target})
        })))
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
  - request:
      method: POST
      path: /reviews/{id}/decisions
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
    inputs:
      id: !cel "request.params.id"
      author: !cel "request.body.author"
      decision: !cel "request.body.decision"
      revision: !cel "request.body.revision"
      hash: !cel "request.body.hash"
      note: !cel "has(request.body.note) ? request.body.note : null"
    handler:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [id, author, decision, revision, hash, note]
          properties:
            id: { type: string }
            author: { type: string }
            decision: { type: string, enum: [approve, request_changes, reject] }
            revision: { type: integer }
            hash: { type: string }
            note: { type: [string, "null"] }
      outputType: !ref ReviewDecisionAnswer
      steps:
        # … the review, else ERR_REVIEW_NOT_FOUND
        - name: latest
          invoke: { kind: Sql.Query, connection: !ref db }
          inputs:
            sql: !sql >-
              SELECT seq, hash FROM review_revisions
              WHERE review_id = ${{ inputs.id }} ORDER BY seq DESC LIMIT 1
        - name: current
          if: !cel "steps.latest.result.rows[0].seq != inputs.revision || steps.latest.result.rows[0].hash != inputs.hash"
          then:
            - name: superseded
              throw:
                code: ERR_REVISION_SUPERSEDED
                displayMessage: "Revision {$latest} has replaced the one you read. Read it before deciding."
                data: { latest: !cel "steps.latest.result.rows[0].seq" }
        - name: state
          value: !cel "{'approve': 'approved', 'request_changes': 'changes_requested', 'reject': 'rejected'}[inputs.decision]"
        # … `UPDATE reviews` to that state and `last_reviewed`, and an event recorded
      outputs:
        id: !cel "inputs.id"
        decision: !cel "inputs.decision"
        state: !cel "steps.state.result"
        revision: !cel "inputs.revision"
    returns:
      - status: 201
        content: { application/json: { body: !cel "result" } }
  # POST /reviews/{id}/comments: the closed body `{ author, body, revision, item? }`
  # (`item` matching `^[A-Z]+[0-9]+$`), refused with ERR_REVISION_NOT_FOUND or
  # ERR_ITEM_NOT_FOUND, answering 201 `ReviewCommentAnswer`.
  - request:
      method: GET
      path: /workers/{name}/commands
      schema:
        params: { type: object, required: [name], properties: { name: { type: string } } }
        query: *listQuery
    inputs:
      # §8: fixed by the route; the client cannot send or widen it.
      scope: { worker: !cel "request.params.name" }
      filters: *listFilters
      sort: *listSort
      facet: *listFacet
      limit: *listLimit
      cursor: *listCursor
    handler:
      kind: Crud.Reader
      connection: !ref db
      collection: !ref commands
      select: !sql |
        SELECT seq AS seq, worker AS worker, type AS type, state AS state, created_at AS createdAt
        FROM worker_commands
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
```

`telo.yaml` imports `TextDiff` (`../../modules/text-diff`), includes `./pages-review.yaml`, lists the four pages in every application with `{ type: page, page: !ref inbox }` in each navigation, and mounts `reviewApi` at `/api/review` under each of its four mounts.

Before, the same address was a query parameter on a literal page, and the inbox list was a bespoke route with its own parameters:

```yaml
kind: Ui.Page
metadata: { name: review }
path: /review
title: Review
query: { id: { type: string } }
children:
  - type: composite
    ref:
      kind: Ui.Data
      model: !ref ReviewDetail
      query: { id: { type: string } }
      source: { path: /api/review/review-detail, queryParams: { id: !cel "query.id" } }
      content: { type: value, value: !cel "data.review.title" }
```

### Refused

Each change below is made to the example above, one at a time; each is what `telo check examples/ui-showcase/telo.yaml` reports.

```
# the showcase's navigation.items gains { type: page, page: !ref review }
telo.yaml  error  UiReact.App/showcase at 'navigation.items[7]': names a page with a variable in its
                  path, which a navigation entry cannot fill. Reach the page with a link whose
                  pathParams fill it, or remove the entry.  RESOURCE_RULE_VIOLATED

# the inbox listing's title column links with pathParams: { id: !cel "params.id" }
pages-review.yaml  error  Ui.Page/inbox: !cel: 'params.id' is not defined (available: )  CEL_UNKNOWN_FIELD

# the worker listing's reloadEvery: 1s
pages-review.yaml  error  Ui.Page/worker: /children/2/ref/reloadEvery must be a Telo.Duration at
                          least 5s, not 1s  SCHEMA_VIOLATION

# the review page's time reads data.review.title
pages-review.yaml  error  Ui.Page/review: CEL at 'children[1].ref.content.children[1].value':
                          'data.review.title' is a string with no format; the field takes a string
                          of format date or date-time.  CEL_TYPE_ERROR

# the preset's state filter takes the relative value { unit: day, offset: -1 }
pages-review.yaml  error  Ui.Filters/inbox_children_1_ref at 'children[1].ref.presets[1]': sets a
                          value its filter cannot hold: … or a relative value on a filter that is
                          not a `date` or `date-time` one with `eq`, `gt`, `gte`, `lt` or `lte`.
                          RESOURCE_RULE_VIOLATED

# the Approve button binds hsh instead of hash
pages-review.yaml  error  Ui.Page/review: inputs at 'children[1].ref.content.children[3].children[0].inputs'
                          do not satisfy the inline Ui.Action's declared inputType: / must NOT have
                          additional properties ('hsh' is not allowed)  CONTRACT_INPUTS_MISMATCH

# the review page's annotation line reads row.lnie
pages-review.yaml  error  Ui.Page/review: !cel: 'row.lnie' is not defined (available: id, line, count)
                          CEL_UNKNOWN_FIELD

# the commands route's scope key is misspelled workr
api.yaml  error  Http.Api/reviewApi: inputs at 'routes[5].inputs.scope' do not satisfy the inline
                 Crud.Reader's declared inputType: /scope must NOT have additional properties
                 ('workr' is not allowed)  CONTRACT_INPUTS_MISMATCH

# the commands route scopes seq by the worker's name
api.yaml  error  Http.Api/reviewApi: CEL at 'routes[5].inputs.scope.seq' reads 'request.params.name',
                 whose declared shape does not fit what the inline Crud.Reader's declared inputType
                 expects: /: type mismatch — source is 'string', target expects 'integer'.  CEL_TYPE_ERROR

# a second page with path /reviews/{key}, listed after review
telo.yaml  error  UiReact.App/showcase at 'pages[14]': declares a path another page already has, or
                  one differing from it only in the names of its variables, so both route the same
                  addresses. Give each page a path of its own.  RESOURCE_RULE_VIOLATED
                  (and the same at the new page's entry, 'pages[17]')
```

## 1. Page variables

### Page paths

Before: a page `path` is a literal, and `{` in it is text. After: a segment may be `{name}`, standing for exactly one non-empty segment, percent-decoded — the `{name}` syntax `Ui.Address` and `x-telo-path-params-for` already use.

- A segment is either wholly literal or exactly `{name}`; a brace anywhere else, or a repeated name, is `SCHEMA_VIOLATION`.
- A literal segment beats a variable one (`/reviews/new` over `/reviews/{id}`). Two pages whose paths differ only in variable names route the same addresses and are `UI_PAGE_PATH_DUPLICATE` — the existing rule, now comparing paths with variable segments erased.
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

Invalidation already matches the resolved request path; a templated `basePath` joins it as it resolves, so a write under `/api/review/workers/a/commands` reloads worker `a`'s listing and not worker `b`'s.

Docs: `page.md` (variables, routing, `params`), `nodes.md` (the `params` root), `collection-source.md`, `listing.md`, `modules/http-server/docs/returns-and-catches.md`; the annotation in the analyzer guide and the root `CLAUDE.md` annotation list.

**Verify:**
- An `inbox` row's title links to `/reviews/<id>`; the `review` page there reads `GET /api/review/reviews/<id>`.
- A literal segment and a variable one both route, the literal winning (`modules/ui-react/tests/page-routing.yaml`); the duplicate-path refusal above.
- A `Ui.View` reading `params.id`, placed on a page with `{id}` and on one without, is `CEL_UNKNOWN_FIELD` naming the page without — the same when the view comes from an imported library (`modules/ui/tests/page-variables.yaml`).
- The navigation refusal is pinned both ways in `modules/ui-react/tests/static-refusals.yaml`: refused by `telo check` at the declaring application, and `runFails:` from a consumer `telo check` does not reach.
- The `worker` page for `a` reloads on a write under `/api/review/workers/a/commands` and not under `b`'s.
- Loaded directly, `/reviews/%ZZ` and `/reviews/%E0%A4%A` answer 404 with the shell and draw the not-found page, as a move inside the app to either address does (`modules/ui-react/tests/page-routing.yaml`).

## 2. Timed reload

`reloadEvery` — a duration — on `Ui.Data` and `Ui.Listing`, declared `x-telo-type: { name: Telo.Duration, minimum: 5s }`. Unset, nothing changes. It is a literal: a value below `5s` is refused by the value type's own bound (`SCHEMA_VIOLATION` at check, `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` at creation).

- A tick reloads everything the node reads under the listing's existing reload rule (loaded pages refetched in order, the first page only past ten, records matched by `key`, so focus, open surfaces, expanded state and entered values stay). For a listing that is every group, period and loaded level, and the facet requests over its source.
- A tick is skipped while a read of that node is in flight, and not run while the document is hidden; coming back to visibility runs one read if an interval has passed. A node hidden by `shown` reads nothing.
- A read that fails on a tick keeps what is drawn and shows the node's `failure` beside it, as a failed reload of `Ui.Data` does today; the next tick tries again.
- `Ui.Data` keeps its content mounted, as it does for `reloadOn`.

Docs: `data.md`, `listing.md`.

**Verify:**
- The `worker` page with two loaded pages of commands shows a new command within one interval, still on its second page, scroll position unchanged.
- An open Approve prompt on the `review` page keeps its entered values across a tick.
- A hidden tab makes no request; showing it makes one. A tick during a slow read makes no second request.
- `reloadEvery: 1s` is refused at check and at creation.

## 3. Markdown with annotations

The wire `markdown` node and its renderer already ship (`ui-react`'s Markdown chunk: CommonMark with GFM, raw HTML drawn as text, links and images held to the address rule, code highlighted). What a page cannot do is write one.

`Ui.Node` gains `{ type: markdown, value, annotations?, style?, when?, shown?, fill? }`, the authoring twin of the wire node, one-to-one: `value` is an accessor to a string, resolved to the wire node's binding, which is named `value` too, and a chain to anything else is `CEL_TYPE_ERROR`. `value` is an accessor on every `Ui.Node` branch declaring it (`value`, `time`, `markdown`), since a union whose branches give one property different eval modes is `EVAL_MODE_BRANCH_CONFLICT`.

**Annotations** are items the server names. `annotations` is `{ rows, line, count?, action }`, on both the authored and the wire node:

- `rows` is an accessor to a list; each element is `row` (`x-telo-context-element-from-item: "0/rows"`). Which blocks are items, and their IDs, are the server's grammar; the node parses none.
- `line` is an accessor over `row` to the 1-based source line that starts the item, an integer; `count` an optional accessor to an integer shown on the control as a `badge`.
- `action` is a `Ui.BoundAction` (§4) whose region binds `row` beside the roots in scope. Its control reads the action's `label`.
- The control is drawn on the block containing `line` (a list item for an item line, a heading for a heading line); two annotations on one block draw two controls in order. An annotation whose line is past the text is drawn after the text with its control, so nothing is lost silently.

The part list's `markdown` group gains `markdown-annotations` (the element inside a block holding its controls), `markdown-annotation` (one control: the `row-action` button, the `badge` with the count, and the `row-answer` / `row-failure` of a press) and `markdown-unplaced-annotations` (the area after the text), styled by the default theme and by `ui-react-radix`. `ui_react_controls-4` is unchanged.

Docs: `nodes.md` (the authored node, annotations), `modules/ui-react/docs/markdown.md` (placement).

**Verify:**
- The `review` page shows the latest revision's body; each item has a Comment control with its count; pressing one opens the prompt with `author` and `body`, and sends `item` set to the item's ID.
- The `## S9` heading inside a fenced block of `r1`'s latest revision gets no control, because the server names none there.
- An annotation naming line 999 of a ten-line text is drawn after it.
- `row.lnie` in `line` is `CEL_UNKNOWN_FIELD`; renderer tests pin the placement.

## 4. A button bound to page data

Before: a `Ui.Action` placed on a page takes its input from its own form only, so it cannot send the ID in the path or the revision a reader read; only a row of a listing or a `list` can bind inputs, through `Ui.RowAction`.

After: the entry shape is renamed `Ui.BoundAction` (`{ action, inputs, confirm?, prompt?, enabled? }`, its twin `ERR_UI_BOUND_ACTION_INPUTS_INVALID`), since it now has uses with no row, and a `button` node runs one over the roots in scope:

- `{ type: button, action, inputs, confirm?, prompt?, enabled?, button?, style?, shown? }`. `inputs` reads `params`, `query` and the roots of the tree the button sits in (`data` in a reader), and is judged against the action's `inputModel` as a row action's is, with the same codes. `button` is a `Ui.ButtonDisplay`, as on `link`. The button reads the action's `label`.
- It draws as a row action does: the answer in place of the button, the `failure` beside it (or in the open prompt), no press while one is pending.
- `rowActions` on a listing and a `list`, and `annotations.action`, keep their keys and take `Ui.BoundAction`.
- **The person completes the record.** The input model states what the operation truly requires. With `prompt: true` a required input may be left unbound: the prompt asks for the action's fields the inputs do not bind and holds the bound and the entered values together against the whole input model, so a required field left empty blocks sending; bound values are always sent and never drawn. The `action` slot declares `x-telo-ref: { kind: Self.Action, use: dependency, inputs: /inputs, completedWhen: /prompt }`, so where `prompt` is literally `true` the call-site check reports no required input missing; an unknown key and a value's type are still judged. `ERR_UI_BOUND_ACTION_INPUTS_INVALID` likewise refuses an unbound required input only when `prompt` is not true. Without `prompt`, every required input is bound.
- The action stays a complete form: a property its `inputModel` requires with no field is `UI_FIELD_REQUIRED_NOT_ENTERED`, whatever binds it. The decisions route requires `note` for `request_changes` with `if` / `then` in its body schema, and answers a 400 the prompt shows on that field.

Docs: `nodes.md` (the `button` node), `action.md` and `listing.md` (the renamed shape).

**Verify:**
- Approve on the `review` page sends `POST /api/review/reviews/r1/decisions` with `{ author, decision: approve, revision, hash }`, and the review reader reloads.
- Request changes with an empty note shows the 400 on `note` in its prompt.
- A stale revision draws the `ERR_REVISION_SUPERSEDED` failure beside its button.
- `data.review.latestRevison.seq` is `CEL_UNKNOWN_FIELD`; the `hsh` refusal above; Approve with `prompt: false` is `CONTRACT_INPUTS_MISMATCH` at check (`/ is missing required property 'author'`) and `ERR_UI_BOUND_ACTION_INPUTS_INVALID` at run; an action with `fields: [author]` over a model requiring `[id, author]` is `UI_FIELD_REQUIRED_NOT_ENTERED` whatever binds it.

## 5. Style rules on `list`

A `list` node takes `rowStyle`, and a column takes `style`, each a style rule over `row`, as a listing's do. Docs: `nodes.md`.

**Verify:** the `compare` page draws added lines `success`, removed lines `danger` and context lines `muted`, and the compared revisions `strong`; a `by` that is not a plain chain is `ACCESSOR_NOT_PLAIN_CHAIN`.

## 6. Relative values

### In filters

A `date` or `date-time` filter's `default` and a preset's value may be `{ unit: minute | hour | day | week | month | year, offset }`: now moved by `offset` units in the viewer's time zone — the instant for a `date-time`, that moment's date for a `date`. Legal with `eq`, `gt`, `gte`, `lt`, `lte`; not with `in`.

- A value from a relative default or preset stays relative while the viewer leaves it: the active preset is still read off the bar's values, the address and the store keep the spelling `now<±n><unit>` (`now-1day`), and the value is resolved when a listing reads its first page. Every later page of that sequence, and every page of one reload cycle, sends the same resolved value, since the next page's cursor was issued for it; the next first-page read, a reload cycle or a filter change resolves it again.
- Typing a value replaces it with an absolute one.
- A relative value on another property type, or with `in`, is `UI_FILTER_DEFAULT_INVALID` / `UI_FILTER_PRESET_VALUE_INVALID`, the codes the other defaults use.

**Verify:** the `inbox` preset "Waiting a day or more" sends `revisedAt.lte=<now − 1 day>`; loading a second page minutes later sends the same instant and is answered, not refused for its cursor; a tick resolves it again; the same link a day later asks relative to that day; the preset stays active after a reload; the address reads `now-1day`.

### Relative time display

`Ui.Node` gains `{ type: time, value, relative?, style?, when?, shown?, fill? }`, and a `list` column becomes a closed `oneOf`: the value column, with an optional `type: value`, and `{ type: time, header?, value, relative?, href?, shown?, style? }`, the members both take written once. `value` is `x-telo-eval: accessor`, `type: string`, `anyOf: [{ type: string, format: date }, { type: string, format: date-time }]`; `relative` a boolean, default `false`. `relative: true` draws relative time in the viewer's language ("3 hours ago"), with the exact time as its tooltip and the element's machine-readable time, refreshed every minute while on screen; `false` draws the absolute date or time in the viewer's language and time zone. `Ui.SpecNode` carries the matching `time` node and column, `relative` always present and `present` (`type`, `format`) where the value's schema says; a wire time column carries `type: time`, a value column, as today, no `type`.

- A chain to a string with no date format is `CEL_TYPE_ERROR` by the generic format-aware accessor fit (`'data.review.title' is a string with no format; the field takes a string of format date or date-time`).
- A tree the load analysis does not judge — a reader in a dependency — is refused when the node is resolved, as `ERR_UI_TIME_VALUE_NOT_DATE`, when the schema its value reads is a declared string with no `format: date` or `date-time`.
- A runtime string that is not a date is drawn as plain text.
- `relative` on a `value` node is `SCHEMA_VIOLATION`.

**Verify:** a `date-time` three hours back reads "3 hours ago", the exact time on hover; `ERR_UI_TIME_VALUE_NOT_DATE` is pinned both ways in `modules/ui/tests/` — refused by `telo check` at the declaring library, and `runFails:` from a consumer.

Docs: `filters.md`, `nodes.md`.

## 7. One remembered value across forms

Before: entries sharing a `state` key read the store and the address once, when they mount, and a write replaces the whole stored entry with the writer's own `fields`. So `author` entered in one prompt is not seen by an entry already mounted, and a narrower entry's write erases a wider one's other properties.

After, as "one key is one state" already documents: entries sharing a `state` key and store hold each kept property as one value. A store write merges property by property, and every entry mounted in the document follows a change another entry makes to a property it keeps, from the address and the store alike. Another tab sees it at its next mount.

Docs: `field-kinds.md` (kept values).

**Verify:** renderer tests — `author` entered in a Comment prompt prefills the Approve prompt; a narrower entry's write keeps a wider entry's other kept property.

## 8. Lists over any SELECT, and the review page set

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

**Verify:** `crud`'s list, declared-query and facet tests pass unchanged; the two `scope` refusals above; `scope: !cel "{'runnr': request.params.name}"` passes check and fails at dispatch with `ERR_INPUT_INVALID`, a row in `tests/check-run-agreement.yaml`; `ui`'s listing and option-source tests still refuse an unknown filter key, now as `SCHEMA_VIOLATION`; the `worker` page's commands for `a` never include `b`'s, and `?worker=b` is a 400 (`examples/ui-showcase/tests/review-screens.yaml`).

### The review page set

The showcase's review API is the pages' own backend, the router `reviewApi` at `/api/review`, over tables of the showcase's own SQLite database.

- **Tables** — `review_products` (each with a `deadline_seconds`), `reviews`, `review_revisions` (each revision's whole Markdown and its SHA-256), `review_items` (the items a revision holds and the line each starts on, stored with the revision: which blocks are items is the server's grammar, so a heading inside a fenced block is none), `review_comments`, `review_events` and `worker_commands`, every one seeded, so each page is populated on a fresh database.
- **Two lists** are `Crud.Reader`s over fixed `!sql` SELECTs, each over a declared `DataModel.Collection` the screen's `Ui.CollectionSource` names too: the reviews list joins every review to its latest revision and its product, computing `revisedAt` and `overdue`; a worker's commands are held to it by `scope: { worker: … }`, and an unknown worker answers an empty page.
- **A document** (`GET /reviews/{id}`) answers its latest revision with `body`, `hash` and items `{ id, line, count }`, `count` the comments on that item in that revision, and its timeline.
- **The decision and comment routes** take closed body schemas, the decision's requiring `note` for `request_changes` with `if` / `then`. A decision names the revision and hash it was made on, and the step comparing them with the latest revision throws `ERR_REVISION_SUPERSEDED` (409) when another has replaced it.
- **`GET /reviews/{id}/compare?base=&target=`** answers `{ base, target, comparable, lines: [{ op, text }], revisions }` from `TextDiff.lineDiff` over the two stored revision bodies (`comparable: false` beyond its byte limit); `revisions` marks the two compared. Omitted, `base` is the revision last decided on (the first when none was) and `target` the latest.

```
$ curl -s 'localhost:8150/api/review/reviews?state.in=submitted&state.in=revised&revisedAt.lte=2026-11-06T09:00:00Z&sort=-revisedAt&limit=2'
{"rows":[{"id":"r7","title":"Translate the handbook into Polish","product":"handbook","repo":"docs","state":"submitted","revisedAt":"2026-11-06T07:30:00Z","overdue":true},
        {"id":"r1","title":"Rewrite the onboarding chapter","product":"handbook","repo":"docs","state":"revised","revisedAt":"2026-11-05T16:20:00Z","overdue":true}],
 "total":4,"next":"WyItcmV2aXNlZEF0Ii…"}

$ curl -s 'localhost:8150/api/review/reviews?facet=product'
{"values":[{"value":"handbook","count":4},{"value":"website","count":3}],"next":null}

$ curl -s 'localhost:8150/api/review/reviews?age=24h'
{"type":"about:blank","title":"Bad Request","status":400,"detail":"The list request is not valid.","code":"ERR_CRUD_QUERY_INVALID",
 "data":{"issues":[{"pointer":"/query/age","keyword":"additionalProperties","params":{"additionalProperty":"age"}}]}}

$ curl -s 'localhost:8150/api/review/workers/a/commands?worker=b'
{"type":"about:blank","title":"Bad Request","status":400,"detail":"The list request is not valid.","code":"ERR_CRUD_QUERY_INVALID",
 "data":{"issues":[{"pointer":"/query/worker","keyword":"additionalProperties","params":{"additionalProperty":"worker"}}]}}

$ curl -s 'localhost:8150/api/review/reviews/r1' | jq '.review.latestRevision.items'
[{"id":"S1","line":3,"count":2},{"id":"S2","line":9,"count":0},{"id":"S3","line":17,"count":1}]

$ curl -s 'localhost:8150/api/review/reviews/r1/compare' | jq '{base, target, comparable, revisions}'
{"base":1,"target":3,"comparable":true,
 "revisions":[{"seq":1,"createdAt":"2026-11-01T10:00:00Z","base":true,"target":false},
              {"seq":2,"createdAt":"2026-11-03T12:30:00Z","base":false,"target":false},
              {"seq":3,"createdAt":"2026-11-05T16:20:00Z","base":false,"target":true}]}
```

**Verify:** the curl shapes above; the reviews SELECT holds no clause built from the request; `examples/ui-showcase/tests/review-screens.yaml` passes under `examples/test-suite.yaml`; `pnpm run telo examples/ui-showcase/telo.yaml` serves the `inbox`, `review`, `compare` and `worker` pages with no frontend build.

## 9. Docs, guides, ledger

- `modules/ui/README.md` and the docs named above; `modules/ui-react/` docs for the renderer parts; `modules/crud/` docs and README for the exported reader.
- `examples/ui-showcase/README.md`: the review pages, their routes and their test.
- `apps/hub/guides/build-ui.md` and `apps/authoring-agent/chat/primer.md`: page variables and `params`, `reloadEvery`, the `markdown` node and annotations, the `button` node and `Ui.BoundAction` with `prompt` completing the record, `list` styles, relative values, the `time` node, `Crud.Reader` over a SELECT with `scope`, and a member-form map refusing a key the model does not declare.
- `docs/guides/what-you-get.md`, under Standard library: "Routes keyed by ID" (page paths with variables, refused before the app runs when a page lacks a variable a screen reads); "Screens that reload in place" (`reloadEvery` keeps loaded pages, scroll and open forms); "Markdown with review controls" (items the server names get controls; raw HTML is never inserted); the list-endpoint entry extended to any SELECT — filtered, sorted, cursor-paged, with totals and facets, and scoped by the route.
- `modules/CLAUDE.md`: the Declarative UI paragraph gains page variables and `params`, templated `basePath`, the authored `markdown` node with annotations, the `button` node and `Ui.BoundAction`, and `reloadEvery`; the CRUD paragraph gains the exported reader.
- No doc, guide, primer or ledger entry names an application outside this repository; where one needs a review app, it is the showcase's review pages.

## Releases

One fragment per module, written with `telo release add`, each body naming only its own module:

| Module | Kind | What the body says |
| --- | --- | --- |
| `ui` | `Added`, describing the break | page path variables (a brace in a page path is now a variable), the `params` root, templated `basePath`, `reloadEvery`, the authored `markdown` node (`value`) with annotations, the `time` node and time columns (`relative: true`), the `button` node, `Ui.BoundAction` with `prompt: true` leaving the required inputs the person enters unbound, `Ui.RowAction` renamed `Ui.BoundAction`, `list` styles, relative filter values, an unknown filter key now `SCHEMA_VIOLATION` |
| `ui-react` | `Added` | segment routing, annotation placement, the `button` node, timed reload, shared kept values, the `time` node, the annotation parts and the `time` node in the part list |
| `ui-react-radix` | `Added` | styles for the annotation control |
| `http-server` | `Fixed` | a malformed percent-escape is answered by the not-found chain |
| `crud` | `Added`, describing the break | `Crud.Reader` exported, reading a `DataModel.Collection` over a table or a fixed SELECT, with `scope` |

A changeset on the telo line names `@telorun/analyzer` for `x-telo-context-from-path-template`, the corrected member form of `x-telo-value-schema-from`, the format-aware accessor fit, the eval-mode branch guard (`EVAL_MODE_BRANCH_CONFLICT`) and `completedWhen` on `x-telo-ref`. `@telorun/ui-react-contract` takes no changeset.

**`requires:` floors:** `crud` gets one only if the previous published CLI rejects it with the block stripped. `ui` declares `x-telo-context-from-path-template` in its own schemas, so it gets `requires: telo: ">=<the release carrying it>"` if running the previous published CLI against `ui` with the block stripped rejects it; restoring the block must then give `MODULE_REQUIRES_NEWER_RUNTIME`. No other module gets one unless the same test shows it.
