# Building a user interface

A Telo application's screens are declared in its manifest, never written as a
frontend. The `ui` module is the vocabulary — pages, tables, forms, actions,
filter bars, surfaces, themes. The `ui-react` module is a renderer: it serves
that vocabulary to a browser as data a prebuilt React application interprets.
What crosses the wire is a spec, never generated code, so the screen is
type-checked by `telo check` with the rest of the manifest.

Rules that hold throughout:

- **Never generate frontend code, and never use `JS.Script`.** Everything a
  screen does is a declared kind. A component of your own is a browser entry
  a library ships (see *Custom components*), not code in the manifest.
- **Take every field from `get_kinds`.** This guide shows how the pieces fit;
  the exact schema of each kind, and the `imports:` line to write for each
  module (with its version and integrity pin), come from `get_kinds` on the
  `ui`, `ui-react`, `http-server` and — for the generated admin screen —
  `crud` modules. Write each import line exactly as `get_kinds` returns it.
- **The API comes first.** A screen calls routes; it never reaches a database
  or an invocable directly. Declare the routes, then the screen over them.

## When a screen is the answer

Reach for `ui` when a person needs to browse, filter, create, edit or delete
records, or press a button that runs an operation and read what it answered.
For a static or server-rendered page, a document, or an HTML email, use a
template or HTML module instead; for a machine consumer, the API alone.

Who imports what:

- The **application** imports `ui`, `ui-react` and `http-server`, mounts the
  renderer's application on its server, and owns the pages.
- A **library** that describes the interface of its own domain imports `ui`
  alone and exports composites (a table, a form, a `Ui.View`) as instances.
  It never imports a renderer, so the application chooses one.

## The application

`UiReact.App` is a mount. List it under `Http.Server.mounts` beside the API it
calls, after the API's own mounts:

```yaml
kind: Telo.Application
metadata: { name: Tasks, version: 1.0.0 }
imports:
  # One line per module, exactly as get_kinds returns it.
  Http: oci://ghcr.io/telorun/http-server@<version>#<pin>
  Ui: oci://ghcr.io/telorun/ui@<version>#<pin>
  UiReact: oci://ghcr.io/telorun/ui-react@<version>#<pin>
ports:
  http: { env: PORT, default: 8080 }
targets:
  - !ref server
---
kind: UiReact.App
metadata: { name: admin }
title: Tasks
pages:
  - path: /
    title: Open work
    children:
      - { type: text, text: Open work, style: heading }
      - { type: composite, ref: !ref taskTable }
  - path: /about
    title: About
    children:
      - { type: text, text: Tasks tracked by the team. }
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - { path: /api/tasks, mount: !ref tasksApi }
  - { path: /admin, mount: !ref admin }
```

`UiReact.App` stays named, like any router a server mounts, so it can be
tested on its own. A composite used in exactly one place is declared inline at
its node (`ref: { kind: Ui.Table, … }`) and gets a name only when two places
use it — as `taskTable` below is, on a page and inside a filter bar.

- `title` (required) names the application. `pages` (at least one) are
  `{ path, title, children }`; every page gets a navigation link, in order.
- Optional: `lang`, `theme`, `defaultTheme`, `stylesheets` (host paths,
  written `!module-path ./ui.css`), `compactBelow` (the narrow-viewport
  breakpoint).
- A page `path` is literal and unique, never under `/_telo`.

### Nodes

A page's `children` are nodes — plain data with a `type`:

| `type` | Fields |
| --- | --- |
| `box`, `stack`, `columns` | `children` |
| `text`, `badge` | `text` |
| `link` | `text`, `href` |
| `image` | `src`, `alt` (required, may be empty) |
| `svg` | `markup`, `alt` — drawn as an image, never inserted |
| `composite` | `ref` — a `!ref`, or an inline declaration |

Every node also takes `style` (one or a list of `heading`, `subheading`,
`muted`, `strong`, `accent`, `danger`, `warning`, `success`) and `when` (a
boolean). There is no layout field and no button node: arrangement is the
renderer's styling, and a button that does something is a `Ui.Action`.

**Addresses.** An address inside the application — a page `path`, a `link`'s
`href`, an `image`'s `src`, a `source.basePath`, an action's `source.path` —
is app-relative: `/` followed by anything but `/` or `\`, with no control
character. `/`, `/done` and `/a//b` are valid; `//host` and `/\host` are
refused. A `link` may also start `https://`, `http://` or `mailto:`; an
`image`, `https://` or `http://`. A `link`'s `href` and an `image`'s `src`
resolve under the application's mount; a `source.basePath` and an action's
`source.path` are paths on the server's origin — where the API is mounted.

**Per request.** Inside `pages[].children`, a node's `when` and its leaf
values (`text`, `href`, `src`, `alt`, `markup`, `style`) may be `!cel`,
evaluated for every request against `request.headers` (lower-case names; test
with `in` first) and `request.ip`:

```yaml
children:
  - type: composite
    ref: !ref salaryTable
    when: !cel "'x-role' in request.headers && request.headers['x-role'] == 'hr'"
  - { type: text, text: !cel "'Signed in from ' + request.ip", style: muted }
```

The tree's structure and every `ref` stay literal: a computed `children` list
or `ref` is `REF_SLOT_COMPUTED`. A value that is no valid node once evaluated
is replaced by an `error` node for that request, and the rest of the page is
served.

## Shapes first

Every table, form, filter bar and action is drawn from a JSON Schema shape — a
`Telo.JsonSchema` resource. Declare the shapes once and give the same ones to
the routes and to the screen, so a rename is a `telo check` error rather than a
blank column. A property's `title` is its label and column header; its `type`,
`format` and `enum` decide how it is entered and shown.

```yaml
kind: Telo.JsonSchema
metadata: { name: NewTask }
schema:
  type: object
  required: [text]
  additionalProperties: false
  properties:
    text: { type: string, title: Task, minLength: 1 }
    status: { title: Status, enum: [open, blocked, done] }
    dueOn: { type: string, title: Due, format: date }
---
kind: Telo.JsonSchema
metadata: { name: Task }
extends: NewTask
schema:
  type: object
  required: [id]
  properties:
    id: { type: integer }
```

A shape shares properties with another through `extends:`; shapes are never
derived by an expression.

## Lists — `Ui.Collection` and `Ui.Table`

What a list accepts is declared, never inferred from a row's types. A
`Ui.Collection` lists the filters (`{ property, operator }`, operator one of
`eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`) and the sort properties the
API's list takes. Both lists are required; write `[]` for none.

```yaml
kind: Ui.Collection
metadata: { name: taskQuery }
query:
  filters:
    - { property: text, operator: contains }
    - { property: status, operator: in }
    - { property: dueOn, operator: gte }
    - { property: dueOn, operator: lte }
  sort:
    - { property: dueOn }
```

A `Ui.Table` names its row `model`, its `collection` and its `source`:

```yaml
kind: Ui.Table
metadata: { name: taskTable }
model: !ref Task
collection: !ref taskQuery
source: { basePath: /api/tasks }
rowKey: id
columns:
  - value: !cel "row.text"
  - header: When
    value: !cel "row.dueOn"
rowStyle: { by: !cel "row.status", cases: { blocked: danger, done: muted } }
pageSize: 50
delete: true
```

- `columns` left out is one column per model property but the row key. A
  column is `{ header?, value, style? }` or `{ header?, cell }` (a
  `Ui.Component`). A column sorts exactly when its value is `row.<property>`
  and the collection lists the property under `sort`.
- `row.<property>` in a `value`, a style rule's `by` or a component's `props`
  is an accessor: a plain chain or a literal — no call, operator or index
  (`ACCESSOR_NOT_PLAIN_CHAIN`). A style that depends on data is a rule
  (`{ by, cases, default? }`), never an expression.
- A string property with `format: uri` or `uri-reference` is drawn as a link.
  A link to a declared page moves within the application; any other — a file
  served by an `Http.Static` mounted beneath the application's mount — opens
  beside it.
- `source.filters` fixes equalities on every request (each a property the
  collection declares with `eq`).

**The collection contract** — what `source.basePath` must answer:

- `GET <basePath>?limit=&cursor=&sort=` plus `<property>=` (equals) and
  `<property>.contains|gt|gte|lt|lte|in=` (`in` repeated per value), answering
  `{ rows, total, next }`; `next` is `null` on the last page.
- `POST <basePath>` creates; `GET`, `PUT` and `DELETE <basePath>/<key>` read,
  replace and delete one record. `PUT` replaces the whole record: a property
  left out is cleared.
- A write body holds only the properties that have a value, in the model's
  JSON types; answer a `null`, or a value of another JSON type, at a typed
  property with a 400 naming it.
- A row read is a record valid against the model, so it can be sent back: a
  property with no value is left out (`null` only where the model admits
  `null`).
- A refusal is a 400 with the request-validation envelope `{ error:
  "ValidationError", message, status: 400, details: [{ location, path,
  message }] }`; a detail whose `path` is a field's property marks that field.
- 401 and 403 are shown where they happened. Query keys beginning `_telo` are
  the renderer's.

A hand-written API that speaks this contract can sit behind any table. Over
one SQL table, `Crud.Resource` speaks it for you (see *An admin screen over
one table*).

## Filter bars — `Ui.Filters`

A filter bar is a container: every table inside its `content` obeys it.

```yaml
kind: Ui.Filters
metadata: { name: taskFilters }
model: !ref Task
collection: !ref taskQuery
fields:
  - { property: text, operator: contains, pinned: true }
  - { property: status, operator: in, control: options, default: [open, blocked] }
  - { property: dueOn, operator: gte }
  - { property: dueOn, operator: lte }
presets:
  - label: Blocked
    values:
      - { property: status, operator: in, value: [blocked] }
policy:
  show: chosen
  summary: chips
  placement: { kind: Ui.CollapsiblePlacement }
  state: { key: tasks, address: true, store: { kind: Ui.LocalStore } }
content: { type: composite, ref: !ref taskTable }
```

- `fields` left out is one control per collection filter. A listed field is
  a `{ property, operator }` pair the collection declares, plus optional
  `pinned`, `control` (`auto`, `select`, `options`, `toggle`, `slider`,
  `tags`, `none`) and `default` (one value, a list under `in`).
- `policy` is one record of independent choices — `show` (`all` | `chosen`),
  `controls` (`direct` | `chips`), `apply` (`commit` | `typing` | `button`),
  `summary` (`none` | `chips`), `placement`, `state` — and every combination
  is valid. Under `apply: button` only what is typed or picked in a control
  waits for Apply; a preset, Reset and removing a summary chip act at once,
  and Apply and Reset stay outside whatever folds.
- **Placements and stores are kinds**, chosen by `kind:` (inline or `!ref`):
  `Ui.AbovePlacement` (the default), `Ui.AsidePlacement`,
  `Ui.CollapsiblePlacement`, `Ui.OverlayPlacement`; `Ui.LocalStore`,
  `Ui.SessionStore`. A `state` keeps the bar's values in the page address
  (`address: true`), a store, or both; left out, they live in memory.
- `pinned` means something only where the bar folds; on a bar that folds
  nothing `telo check` warns `UI_FILTER_PINNED_UNUSED`. A folding placement
  with no unpinned filter on show has nothing to fold and draws no toggle.

## Forms and where they open — `Ui.Form` and surfaces

A `Ui.Form` names a `model` and the `source.basePath` it writes to; `fields`
left out is one field per enterable property (a scalar, or a list of
scalars). The model decides each control — a boolean is a checkbox, an `enum`
a select, a list whose `items` declare `enum` a multi-choice, any other list
typed tags — and there is no per-field control key. An object property gets
no field (`UI_FORM_FIELD_UNSUPPORTED` if listed).

A table opens a form through `create` and `edit`, each an object — never a
bare form:

```yaml
kind: Ui.Table
metadata: { name: taskTable }
model: !ref Task
collection: !ref taskQuery
source: { basePath: /api/tasks }
create:
  form: { kind: Ui.Form, model: !ref NewTask, source: { basePath: /api/tasks } }
  surface: { kind: Ui.Drawer, side: end, compact: { kind: Ui.Dialog, size: full } }
  afterSubmit: again
edit:
  form: { kind: Ui.Form, model: !ref NewTask, source: { basePath: /api/tasks } }
  surface: { kind: Ui.Panel, address: { name: task } }
  unsaved: confirm
delete: true
```

- `surface` is a **kind**: `Ui.Dialog`, `Ui.Drawer`, `Ui.Popover` (the three
  overlays), `Ui.InlineSurface`, `Ui.Panel` or `Ui.PageSurface`. Each takes
  only the keys that mean something for it, so an inapplicable key is a
  `SCHEMA_VIOLATION`. `address: { name }` puts the open form in the page
  address so it can be linked; give a table's `create` and `edit` the **same**
  name, so one query key (`_telo.open.<name>`) holds whichever form is open —
  empty for create, the row's key for edit. `compact` is the dialog or drawer
  used below the application's `compactBelow`.
- `afterSubmit` is `close`, `keep`, and on `create` also `again`; `unsaved`
  is `confirm` or `discard`.
- **`ui` owns every default.** Leave a key out and the table fills it (a
  medium modal dialog that closes after a save and confirms unsaved input).
  Never restate a default.

An edit form reads the record by its key first and sends back what it held
with the entered values over it, because `PUT` replaces.

## Actions — a button that runs an operation

`Ui.Action` is a form with one button, posting to a route, and lists drawn
from what the route answered. It is reached by URL only: `source.path`, always
one `POST` with a JSON body — no `!ref` to a handler and no `method`.

Declare the route and the action over the **same two shapes**, so the page
cannot send what the route refuses or draw what it does not answer:

```yaml
kind: Telo.JsonSchema
metadata: { name: ReportRequest }
schema:
  type: object
  required: [month]
  properties:
    month: { type: string, title: Month, pattern: "^[0-9]{4}-[0-9]{2}$" }
---
kind: Telo.JsonSchema
metadata: { name: ReportAnswer }
schema:
  type: object
  required: [files]
  properties:
    files:
      type: array
      items:
        type: object
        properties:
          name: { type: string, title: File }
          url: { type: string, title: Download, format: uri-reference }
---
kind: Ui.Action
metadata: { name: generate }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
source: { path: /api/reports }
label: Generate
lists:
  - heading: Files
    rows: !cel "result.files"
    columns:
      - value: !cel "row.name"
      - value: !cel "row.url"
```

The route answers the **action contract**: any 2xx with a JSON object valid
against `outputModel` (read only when `lists` is declared), a 400 with the
validation envelope, 401 / 403, anything else a failure. An `Http.Api`
route's `request.schema.body` takes the JSON Schema written inline — a `!ref`
to a `Telo.JsonSchema` there passes `telo check` and fails at boot — so write
the request shape out there and keep it equal to `inputModel`:

```yaml
kind: Http.Api
metadata: { name: reportsApi }
routes:
  - request:
      path: /reports
      method: POST
      schema:
        body:
          type: object
          required: [month]
          properties:
            month: { type: string, title: Month, pattern: "^[0-9]{4}-[0-9]{2}$" }
    handler: !ref generateReports
    inputs: !cel "request.body"
    returns:
      - status: 200
        content:
          application/json:
            body: !cel "result"
```

- `inputModel` with no properties is a bare button.
- `fields` left out is every enterable input property; every required input
  must be enterable (`UI_ACTION_REQUIRED_INPUT_NOT_ENTERED`).
- In `lists`, `result` is typed from `outputModel` and `row` from the element
  of that entry's own `rows`; both are plain chains. With no `outputModel`,
  any `result.<member>` is `CEL_UNKNOWN_FIELD`. A column's `value` is
  `row.<member>`, `result.<member>` or a fixed value. `telo check` types `row`
  only where the list's `items` are written inline in the answer model or one
  `!ref` away; deeper, `row` is untyped and a misspelled member is not
  reported.
- A list column's header defaults to the member's `title`, else its name, and
  a `format: uri` / `uri-reference` member is drawn as a link — following the
  member through any reference, as a table column does.
- A reference on the way to a column's member (in an action's `outputModel`
  or a table's `model`) that names nothing passes `telo check` and fails with
  `ERR_REF_UNRESOLVED` when the page is first read.

### Row actions

`rowActions` on a table puts one button per entry on every row, before edit
and delete:

```yaml
rowActions:
  - action:
      kind: Ui.Action
      inputModel: !ref Archive
      source: { path: /api/tasks/archive }
      label: Archive
    inputs:
      id: !cel "row.id"
      reason: tidy-up
    confirm: Archive this task?
  - action: !ref reject
    inputs: { id: !cel "row.id" }
    prompt: true
```

- `inputs` is the record sent, checked against that action's own
  `inputModel`: it must bind every required input, with matching types
  (`CONTRACT_INPUTS_MISMATCH`, `CEL_TYPE_ERROR`).
- `confirm` asks a question first; `prompt: true` opens a dialog — titled
  with `confirm`, else the action's label — for the action's fields the row
  does not bind: optional inputs, such as a reason.
- An action used in a row declares no `lists` (`UI_ROW_ACTION_DRAWS_LISTS`).
  On success every table over the same `source.basePath` reloads.

## An admin screen over one table — `crud`

When the screen is a table of records over one SQL table, `crud` gives both
halves from one model:

- `Crud.Model` holds four `Telo.JsonSchema` shapes — `schemas: { read, list,
  create, update }`, all required — and `query: { filters, sort }`. `read` and
  `list` declare a required `id`; `create` and `update` leave it out. A
  `Crud.Model` *is* a `Ui.Collection`, so it is also what the screen offers.
- `Crud.Resource` mounts list / read / create / replace / delete over the
  table, speaking the collection contract, with the model as its request
  contract. It does not create the table: declare it with your SQL backend's
  table and schema kinds.
- `Crud.Ui` is the whole screen — filter bar, sortable paged table, create
  and edit forms, confirmed delete — from `model` (the same model) and
  `basePath` (where the resource is mounted). It does not reference the
  resource.

```yaml
kind: Crud.Model
metadata: { name: taskModel }
schemas:
  read: !ref Task
  list: !ref Task
  create: !ref NewTask
  update: !ref NewTask
query:
  filters:
    - { property: text, operator: contains }
    - { property: status, operator: in }
  sort:
    - { property: dueOn }
---
kind: UiReact.App
metadata: { name: admin }
title: Tasks
pages:
  - path: /
    title: Tasks
    children:
      - type: composite
        ref:
          kind: Crud.Ui
          model: !ref taskModel
          basePath: /api/tasks
          filters: { show: chosen, summary: chips, state: { key: tasks, address: true } }
          create: { surface: { kind: Ui.Drawer, side: end }, afterSubmit: again }
          edit: { surface: { kind: Ui.Panel, address: { name: task } } }
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - path: /api/tasks
    mount: { kind: Crud.Resource, connection: !ref db, singular: task, plural: tasks, model: !ref taskModel }
  - { path: /, mount: !ref admin }
```

`filters` is the bar's whole `policy`; `create` and `edit` are `{ surface?,
afterSubmit?, unsaved? }`. `Crud.Ui` declares no default of its own — a key
left out takes the table's or the bar's.

**When to hand-build instead.** `Crud.Ui` has no key for chosen columns, a
custom cell, a row style, a page size, fewer filters, a filter's `pinned` /
`control` / `default`, presets, chosen form fields or row actions. For any of
those, replace it with what it expands into and edit that: a `Ui.Form` over
the model's `create` shape and one over its `update` shape; a `Ui.Table` over
the `list` shape with `rowKey: id`, `collection:` the model, `create: { form:
…create form, …what create held }`, `edit: { form: …edit form, …what edit
held }` and `delete: true`; and a `Ui.Filters` over the `read` shape, with
`collection:` the model, the table as its `content` and `policy:` what
`filters` held. All share the `basePath`. Nothing else moves.

A screen that is not one table's records — a dashboard, a report, an
operation — is hand-built from the kinds above over routes of your own.

## Themes, styling and custom components

- **`Ui.Theme`** sets design tokens from a closed set — `color.` (`background`,
  `surface`, `text`, `muted`, `border`, `accent`, `accent-text`, `danger`,
  `warning`, `success`), `radius.`, `space.`, `shadow.`, `font.` (a `!ref` to a
  font family resource), `font-size.`, `line-height.` — each a CSS value
  string. `theme:` on the app is one theme or a list of `{ theme, when? }`,
  the first whose `when` holds winning per request.
- **Stylesheets.** Everything the renderer draws carries `data-telo-part`,
  with state in `data-` attributes; that list is a stable contract. Your
  `stylesheets` are unlayered and win over the renderer's layers without
  out-specifying them. `defaultTheme: false` drops the built-in theme.
- **Custom components.** A library ships a browser entry built for the
  renderer's ABI and publishes it with `Ui.ComponentExport` (`entry`,
  `export`, `props` as a shape), exported as an instance. An application
  places it with `Ui.Component` (`component: !ref <Alias>.<export>`, `props`,
  `model` when a prop reads `row`), on a page or as a table `cell`. Props are
  checked against the export's declared shape. The browser entry declares
  `abi: ui_react-1`, the renderer's component ABI: a named export that is a
  React function component, receiving exactly its declared props. It may
  leave only `react`, `react/jsx-runtime`, `react-dom` and `@telorun/ui-react`
  as `external`; anything else it imports is bundled into it. Another ABI or
  another external is replaced by an `error` node at start
  (`ERR_UI_COMPONENT_ABI_UNSUPPORTED`, `ERR_UI_COMPONENT_IMPORT_UNSUPPLIED`).
  Navigation, requests and refresh come from the host: `useHost()` from
  `@telorun/ui-react` returns `location` (`{ path, search, hash }`, the
  page's declared path without the mount prefix), `navigate(to, { replace? })`
  (an app-relative reference), `href(to)` (the same, as an anchor URL with
  the mount prefix), `fetch` (the platform `fetch` with same-origin
  credentials), `notifyChanged(basePath)` (tables over that `basePath`
  re-fetch) and `onChanged(basePath, listener)` (returns the unsubscribe
  function).
- **Reusable sections.** `Ui.View` holds one node tree (`content`), declared
  once and placed wherever needed; a library exports one to describe its own
  interface.

## Manifests wire no events

There is no `onClick` and no handler list. A table's buttons, a form's submit
and a filter's change are built in; an operation is a `Ui.Action`. The
renderer sends the page's same-origin credentials with every request; protect
the routes (or the mount) with a guard, and a 401 or 403 is shown where it
happened.

## Testing a screen

A screen is tested through what it serves, like any other route. Start the
application with `App.Instance` (from the `app` module) in a `Run.Sequence`'s
`with:` and request its documents with an HTTP client:

- `<mount>/_telo/ui/app` is the application document (title, pages,
  stylesheets); `<mount>/_telo/ui/page?path=<page path>` is one page's
  document, its `children` the resolved nodes — `table`, `form`, `action`,
  `filters`, `component`, or `error` with a `code` where a node could not be
  produced.
- Assert what the page offers: the node types, a table's column headers, an
  action's `path` and `fields`, a table's `rowActions`.
- Call the routes the screen uses with the records the page would send — a
  list query, a create, the action's input — and assert the answers,
  including the 400 envelope for a refused record.

```yaml
kind: Run.Sequence
metadata: { name: servesTheTaskScreen }
with:
  - kind: App.Instance
    metadata: { name: app }
    source: ../telo.yaml
    ports: { http: 19412 }
targets:
  - !ref app
steps:
  - name: page
    invoke: { kind: HttpClient.Request, url: "http://127.0.0.1:19412/admin/_telo/ui/page?path=/" }
  - name: verify
    invoke: { kind: Assert.Equals }
    inputs:
      actual:
        status: !cel "steps.page.result.status"
        nodes: !cel "steps.page.result.body.children.map(c, c.type)"
        headers: !cel "steps.page.result.body.children[1].columns.map(c, c.header)"
      expected:
        status: 200
        nodes: [text, table]
        headers: [Task, When]
```

Give each test its own port. Behaviour inside the browser — focus, dialogs,
what a click draws — is the renderer's, already tested; a manifest test
proves what the screen is given and what its routes answer.

## Before you finish

- `telo check` is clean: an unknown column (`CEL_UNKNOWN_FIELD`), a filter the
  collection does not declare (`UI_FILTER_NOT_ACCEPTED`), a key a surface
  does not take (`SCHEMA_VIOLATION`) and a malformed address are all
  reported there, at the line that wrote them.
- Every table, filter bar and action names a route that exists and answers
  its contract.
- The screen and the API read the same shapes; no shape is restated by hand
  except an `Http.Api` route's inline request body.
