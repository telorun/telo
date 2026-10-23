# Building a user interface

A Telo application's screens are declared in its manifest, never written as a
frontend. The `ui` module is the vocabulary — pages, tables, forms, actions,
filter bars, surfaces, design tokens. The `ui-react` module is a renderer: it
serves that vocabulary to a browser as data a prebuilt React application
interprets, styled by a swappable theme. The screen is type-checked by
`telo check` with the rest of the manifest.

Rules that hold throughout:

- **Never generate frontend code, and never use `JS.Script`.** Everything a
  screen does is a declared kind. A component of your own is a browser entry
  a library ships, not code in the manifest.
- **Take every field from `get_kinds`.** The exact schema of each kind, and
  the `imports:` line to write for each module, come from `get_kinds` on the
  `ui`, `ui-react`, `http-server` and — for a generated admin screen — `crud`
  modules. A `Telo.*` kind is built in and needs no import.
- **The API comes first.** A screen calls routes; it never reaches a database
  or an invocable directly. Declare the routes, then the screen over them.

## When a screen is the answer

Reach for `ui` when a person needs to browse, filter, create, edit or delete
records, or press a button that runs an operation and read what it answered.
For a static page, a document or an HTML email, use a template or HTML module
instead; for a machine consumer, the API alone.

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
lang: en   # the language every text below is written in
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
words: !ref Ui.words
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Open work
    children:
      - { type: text, text: Open work, style: heading }
      - { type: composite, ref: !ref taskTable }
  - kind: Ui.Page
    path: /about
    title: About
    children:
      - { type: text, text: Tasks tracked by the team. }
---
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - { path: /admin/api/tasks, mount: !ref tasksApi }
  - { path: /admin, mount: !ref admin }
```

`UiReact.App` stays named, like any router a server mounts. A composite used
once is declared inline at its node (`ref: { kind: Ui.Table, … }`); `taskTable`
below is named because a page and a filter bar both use it.

- `title` (required) names the application. `words` (required) is what the
  renderer draws on its own — `!ref Ui.words`, English. `theme` (required) is
  the look — `!ref UiReact.defaultTheme`, or another theme. `pages` (at least
  one) are `Ui.Page`s — `{ path, title, query?, children }`, each path unique —
  inline or `!ref`, a library's included.
- `navigation: { items, placement? }` is the menu, naming pages by `!ref`,
  never by path: `{ type: page, page, text? }`, `{ type: link, text, href }`,
  `{ type: group, text, items }`, each with `when?` and `icon?` — a
  `UiLucide.Icon` (`name`, a Lucide glyph; module `ui-lucide`; inline when
  used once) or a `Ui.FileIcon` (`file`), drawn in its text's colour, alone in a
  sidebar's rail. Omitted, one entry per page — in the header, behind a menu
  button on a narrow screen. A page entry
  names a page `pages` lists, or `telo check` refuses it. `placement` is a
  kind: `Ui.HeaderNavigation` (the default), `Ui.SidebarNavigation` (`side`,
  `rail: { collapsed }`, `store` keeping its open groups), or a compact one —
  `Ui.OverlayNavigation` (a menu button) or `Ui.TabBarNavigation` (bottom
  tabs, at most `visible`) — which a header's or a sidebar's `compact` names
  for a narrow screen.
- Optional: `translator` (an `I18n.Translator`) and `lang` (a tag, or
  `!cel` over `request.headers` — the negotiated `Accept-Language`) serve every
  text translated; `tokens` (the brand), `stylesheets` (host paths, written
  `!module-path ./ui.css`), `compactBelow` (the narrow-viewport breakpoint),
  `header: { start?, end? }` (nodes on every page around the title and
  navigation; no `query` there).

### Nodes

A page's `children` are nodes — plain data with a `type`:

| `type` | Fields |
| --- | --- |
| `box`, `stack`, `columns` | `children` |
| `text`, `badge` | `text` |
| `link` | `text`, `href` |
| `menu` | `text`, `items` (`link`s behind a button; `strong` marks the current) |
| `tabs` | `tabs: [{ text, children, when? }]`, `address?` (the chosen tab in the page address) |
| `image` | `src`, `alt` (required, may be empty) |
| `svg` | `markup`, `alt` — drawn as an image, never inserted |
| `value` | `value` (an accessor), `text?` — one value, presented as its schema says |
| `list` | `rows` (an accessor), `columns: [{ header?, value, shown? }]`, `heading?` |
| `composite` | `ref` — a `!ref`, or an inline declaration |

Every node also takes `style` (not `tabs`; one or a list of `heading`,
`subheading`, `muted`, `strong`, `accent`, `danger`, `warning`, `success`), `when` (a
boolean deciding on the server whether the node is delivered) and `shown` (a
condition deciding in the browser whether it is drawn — see "Data and
conditions"). There is no layout field: arrangement is the renderer's
styling.

**Texts.** Every label, heading and node text is a text in the module's
`lang:`. A text over data names its values instead of being concatenated, so a
translation chooses the plural: `text: { text: { plural: n, cases: { one:
"{$n} open task", other: "{$n} open tasks" } }, values: { n: !cel "data.open" } }`.
A placeholder nothing binds is refused by `telo check`.

**Addresses.** An address inside the application — a page `path`, a `link`'s
`href`, an `image`'s `src`, a `source.basePath`, an action's `source.path` —
is app-relative: `/` followed by anything but `/` or `\`, with no control
character: `//host` and `/\host` are refused. A `link` may also start
`https://`, `http://` or `mailto:`; an `image`, `https://` or `http://`. Each
app-relative address resolves under the application's mount: mounted at
`/admin`, `source.path: /api/reports` is requested at `/admin/api/reports`, so
serve the API there.

**Per request.** Inside a page's `children` and `header`, a node's `when` and its leaf
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
becomes an `error` node for that request.

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

Shapes share properties through `extends:`, never through an expression.

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
  nothing `telo check` warns `UI_FILTER_PINNED_UNUSED`.

## Forms and where they open — `Ui.Form` and surfaces

A `Ui.Form` names a `model` and the `source.basePath` it writes to; `fields`
left out is one field per enterable property (a scalar, or a list of
scalars). An entry of `fields` is a property name — its control derived from
the model — or a **field kind**: `Ui.InputField` (`control: select | options |
toggle | slider | tags`), `Ui.ChoiceField` / `Ui.PickerField` over an option
source, `Ui.DateRangeField` (`presets`, `initialPreset`). Each judges its own
fit to the model, so `telo check` refuses a control the property cannot take.

```yaml
fields:
  - title
  - { kind: Ui.PickerField, property: ownerId, options: !ref people, group: who }
  - { kind: Ui.DateRangeField, property: period, presets: [{ label: This month, unit: month, offset: 0 }] }
groups: [{ name: who, label: People }]
state: { key: task, address: true }
---
kind: Ui.CollectionOptions
metadata: { name: people }
model: !ref Person
value: !cel "row.id"
label: !cel "row.name"
collection: !ref personQuery
source: { basePath: /api/people, filters: { team: !cel "values.team" } }
search: { property: name, operator: contains }
```

`value` is a property the collection filters with `in` (how a chosen value
is labelled); `source.filters` may read the form's `values`. `groups` keep
their fields together; `state` keeps entered values in the address or a store.

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
- **`ui` owns every default.** Leave a key out and the table fills it.
  Never restate a default.

An edit form reads the record by its key first and sends back what it held
with the entered values over it, because `PUT` replaces.

## Actions — a button that runs an operation

`Ui.Action` is a form with one button, posting to a route, and node trees
drawn from what the route answered. It is reached by URL only: `source.path`, always
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
result:
  type: list
  heading: Files
  rows: !cel "result.files"
  columns:
    - value: !cel "row.name"
    - value: !cel "row.url"
onSuccess:
  refreshes: [/api/reports]
```

The route answers the **action contract**: any 2xx with a JSON object valid
against `outputModel` (read only when `result` or `onSuccess.navigate` reads
it), a 400 with the validation envelope, anything else with a
`{ code, message }` body. An `Http.Api`
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
  must be enterable (`UI_FIELD_REQUIRED_NOT_ENTERED`).
- `result:` is a node tree drawn from a success, over `result` (typed from
  `outputModel`; with none, any `result.<member>` is `CEL_UNKNOWN_FIELD`),
  `input` (the record sent) and `values` (what the form holds now). `failure:`
  is drawn for anything else — a 400 also marks the fields — over `error`
  (`status`, absent with no answer; `code`; `message`), `input` and `values`;
  left out, it shows the error's code and message. An action has no `lists`:
  draw a `list` node in `result`.
- `onSuccess.navigate` is a path into `result` or a fixed address: a declared
  page moves within the app, an `https://` address replaces the page.
  `onSuccess.refreshes` lists app-relative paths: every `Ui.Data` and
  `Ui.Table` over one reads again.
- `concurrency: serial` runs the action's presses on a page one after another
  (default `parallel`); `clearAnswerOn: [<property>]` clears the drawn answer
  when that input changes.
- A reference on the way to a column's member that names nothing passes
  `telo check` and fails at start (`ERR_REF_UNRESOLVED`).

### Row actions

`rowActions` on a table — or on a `list` node, anywhere a list is drawn —
puts one button per entry on every row, before edit and delete:

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
  (`CONTRACT_INPUTS_MISMATCH`, `CEL_TYPE_ERROR`). It reads `row` and the roots
  in scope — a table's declared `query:`, or the roots of the tree a list sits
  in (`data`, `result`, `values`…).
- `confirm` asks a question first; `prompt: true` opens a dialog — titled
  with `confirm`, else the action's label — for the action's fields the row
  does not bind: optional inputs, such as a reason. `enabled` (a condition
  over `row`, with `disabledText`) governs the row's button; the action's own
  `enabled` does not.
- A pressed row draws its action's `result` tree in place of the button (a
  download link, a status) and its `failure` beside it. In a table the answer
  stays while the row is on the page, and every table over the same
  `source.basePath` reloads; the action's `onSuccess` applies too.

## Data and conditions — `Ui.Data`

Data a screen needs when it opens — who is signed in, one record's context — is
a `Ui.Data` reader: `GET source.path`, answered by a JSON object valid against
`model`, then `content` drawn over `data`. It is a composite; place it on a
page. A sign-in gate is a reader plus conditions, not a kind:

```yaml
- type: composite
  ref:
    kind: Ui.Data
    model: !ref Auth
    query:
      signin: { type: string, enum: [denied, expired] }
    source: { path: /api/auth, params: { reason: !cel "query.signin" } }
    reloadOn: [focus, unauthorized]
    content:
      type: stack
      children:
        - type: value
          value: !cel "data.email"
          shown: { at: !cel "data.authorized", matches: { const: true } }
        - type: composite
          ref: !ref reportForm
          shown: { at: !cel "data.authorized", matches: { const: true } }
        - type: text
          text: Sign in to continue.
          shown: { at: !cel "data.authorized", matches: { const: false } }
```

- `loading` / `failure` are node trees too; left out, `ui` fills them. In
  `failure`, `error` is `{ status?, code?, message? }`.
- `reloadOn: [focus]` reads again on window focus; `[unauthorized]` when any
  request inside `content` answers 401. A form or table hidden by a condition
  keeps what it holds, so the screen comes back as it was after signing in.
- A condition is `{ at, matches }`: `at` a plain chain over the roots in
  scope, `matches` a schema in a closed profile (`type`, `const`, `enum`,
  `not`, `allOf`, `anyOf`, `required`, `properties`, `items`, `minItems`,
  `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, numeric
  bounds). A missing value never matches, even under `not`; test absence on
  the parent: `{ at: !cel "data", matches: { not: { required: [email] } } }`.
  `pattern` takes no `.` or `\s` — write a class.
- Roots: `data` (a reader's `content`), `error` (its `failure`), `query`
  (declared `query:` on the reader or the page), `values` (a form's or an
  action's fields), `row` (a `list` column). Each is read only by a condition,
  a `value` / `list` node or `source.params` — never by `!cel` text or `when`,
  which read `request` on a page instead.
- A field's `shown` reads `values`: a hidden field is not sent, but a
  property the model requires still blocks submitting. An action's
  `enabled: { at, matches, disabledText }` disables its button until it holds.
- A `list` draws the rows of one answer and never pages; a growing set is a
  `Ui.Table`.

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
  `basePath` (its path under the app's mount). It does not reference the
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
words: !ref Ui.words
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
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
listen:
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

- **Theme and brand are two keys.** `theme:` is one `UiReact.Theme` — the look
  of every part and, optionally, control sets drawn in place of the built-in
  selects, menus and dialogs: `!ref UiReact.defaultTheme`, an exported theme
  of another module (find one with `search_resources`), or your own `{ kind:
  UiReact.Theme, stylesheets: [!module-path ./look.css] }`. `tokens:` is the
  brand over it: a `Ui.DesignTokens` whose fields are a closed token set
  (`color.*`, `radius.*`, `space.*`, `shadow.*`, `font.*` as a `!ref` to a
  font family, `font-size.*`, `line-height.*`), each a CSS value string,
  written `{ kind: Ui.DesignTokens, color.accent: "#1d4ed8" }`; or a list of
  `{ tokens, when? }`, the first whose `when` holds winning per request.
- **Control sets.** A theme's `controls` lists `UiReact.Controls` sets, each
  declared in the library shipping its browser entry (`entry`, `implements`);
  no two entries implement one control, even one set via two aliases. The
  fifteen inline controls may be replaced in any subset. The nine layer
  controls — `Select`, `MultiSelect`, `Dialog`, `Drawer`, `Popover`,
  `Confirmation`, `Menu`, `Tooltip`, `Navigation` — are replaced as one unit:
  a set implementing any of them implements all nine, or is refused before
  the app runs. `ui-react-radix` exports `theme`, drawn with Radix; a theme of
  yours takes its `controls` whole or none.
- **Stylesheets.** Everything the renderer draws carries `data-telo-part`,
  with state in `data-` attributes; that list is a stable contract. Your
  `stylesheets` are unlayered and win over the renderer's layers without
  out-specifying them.
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
  `@telorun/ui-react` returns `location` (`{ path, search, hash }`, without
  the mount prefix), `navigate(to, { replace? })`
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
the routes (or the mount) with a guard.

## Testing a screen

A screen is tested through what it serves. Start the
application with `App.Instance` (from the `app` module) in a `Run.Sequence`'s
`with:` and request its documents with an HTTP client:

- `<mount>/_telo/ui/app` is the application document (title, pages,
  navigation, stylesheets); `<mount>/_telo/ui/page?path=<page path>` is one page's
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

Give each test its own port. A manifest test proves what the screen is given
and what its routes answer.

## Before you finish

- `telo check` is clean: an unknown column (`CEL_UNKNOWN_FIELD`), a filter the
  collection does not declare (`UI_FILTER_NOT_ACCEPTED`), a key a surface
  does not take (`SCHEMA_VIOLATION`) and a malformed address are all
  reported there.
- Every table, filter bar and action names a route that exists and answers
  its contract.
- The screen and the API read the same shapes; no shape is restated by hand
  except an `Http.Api` route's inline request body.
