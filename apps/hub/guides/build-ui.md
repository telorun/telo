# Building a user interface

`ui` is the vocabulary (pages, listings, forms, actions, filters, surfaces, tokens);
`ui-react` is a renderer serving it as data a prebuilt React app interprets,
styled by a swappable theme.

Rules:

- **No frontend code, and no `JS.Script`.** Everything a screen does is a
  declared kind; a component of your own is a library's browser entry.
- **Exact schemas and `imports:` lines** of `ui`, `ui-react`, `http-server`,
  `data-model` and (admin screens) `crud` / `crud-ui`: the [hub](https://hub.telo.run) (`get_kinds`).
- **The API comes first.** A screen calls routes, never a database; declare the routes first.

## When a screen is the answer

Reach for `ui` when a person browses, filters, creates, edits or deletes
records or runs an operation.

The **application** imports `ui`, `ui-react` and `http-server`, mounts the
renderer on its server and owns the pages. A **library** describing its
domain's interface imports `ui` alone and exports composites (a listing, a
form, a `Ui.View`) as instances; it never imports a renderer.

## The application

`UiReact.App` is a mount. List it under `Http.Server.mounts` beside the API it
calls, after the API's own mounts:

```yaml
kind: Telo.Application
metadata: { name: Tasks, version: 1.0.0 }
lang: en
imports:
  # the lines the hub gives
  Http: oci://ghcr.io/telorun/http-server@<version>#<pin>
  Ui: oci://ghcr.io/telorun/ui@<version>#<pin>
  UiReact: oci://ghcr.io/telorun/ui-react@<version>#<pin>
ports:
  http: { env: PORT, default: 8080 }
targets:
  - !ref server
---
kind: Ui.Page
metadata: { name: openWork }
path: /
title: Open work
children:
  - { type: text, text: Open work, style: title }
  - { type: composite, ref: !ref taskTable }
---
kind: UiReact.App
metadata: { name: admin }
title: Tasks
theme: !ref UiReact.defaultTheme
pages: [!ref openWork]
layout:
  kind: Ui.PageLayout
  header:
    - type: pane
      ref:
        kind: Ui.Navbar
        title: Tasks
        navigation: { items: [{ type: page, page: !ref openWork }] }
---
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - { path: /admin/api/tasks, mount: !ref tasksApi }
  - { path: /admin, mount: !ref admin }
```

`UiReact.App` stays named, as any mounted router; a composite used once is
inline; `taskTable` is used twice. List a `Telo.OpenUrl` after the server in
`targets:`.

- `title` (the document title) and `theme` (`!ref UiReact.defaultTheme`, or
  another) are required. `pages` (at least one) are `Ui.Page`s — `{ path,
  title?, query?, width?, children }`, each path unique — inline, by `!ref`, or
  `{ page, layout }`. A page's `title` draws no heading: put `{ type: text, text,
  style: title }` (the one `h1`) first. A page an address, a navigation
  entry or a `Ui.OpenPage` names must be listed (`UI_PAGE_UNROUTED`).
- `layout` is the `Ui.PageLayout` every page is drawn in (omitted: no chrome):
  `{ width?, header?, aside?, footer? }`; a page's `{ page, layout: { kind:
  Ui.PageLayout } }` has none. `notFound` is the nodes drawn for an unknown
  path. Layout regions read `request`; they withhold `params`/`query`.
- A `pane` node `{ type: pane, ref }` places a `Ui.Pane` (chrome answering one
  node). `Ui.Navbar { title?, start?, end?, navigation, placement? }` is the
  header row (`placement`: `Ui.HeaderNavigation` default, `Ui.OverlayNavigation`,
  `Ui.TabBarNavigation`). `Ui.NavigationColumn { navigation, state? }` in an
  aside is a column, a rail when folded. A composite's regions withhold `request`:
  read it in a page's children or a layout region.
- A path segment may be a variable: `/reviews/{id}` matches one percent-decoded
  segment, a literal one winning. Nodes and queries the page
  places read it as `params.id`; `telo check` refuses a
  variable the page lacks. A navigation `page` entry cannot name such a page:
  reach it with a `to` (*Where a press goes*).
- `navigation: { items }` (required, never derived) names pages by `!ref`:
  `{ type: page, page, text? }`, `{ type: link, text, to }`,
  `{ type: group, text, items }`, each with `when?` and `icon?` (`UiLucide.Icon`
  or `Ui.FileIcon`).
- Optional: `translations: { catalogs }` of `Telo.TextTranslations` serve texts
  in the negotiated `request.lang` (`Http.Server.preferredLanguages`); the
  renderer's own texts are English, so list `ui`'s `Ui.polishTranslations`, …
  to translate them and a `Ui.Translations` (`messages:
  { save: Submit }`) to reword. Also `tokens`, `stylesheets` (`!module-path
  ./ui.css`), `compactBelow`, `pageWidth` (`contained` or `full`; a page's
  `width` wins).

### Nodes

A page's `children` are nodes, plain data with a `type`:

| `type` | Fields |
| --- | --- |
| `box`, `stack`, `columns` | `children`, `press?` |
| `text`, `badge` | `text` |
| `link` | `text`, `to`, `button` (a `Ui.TextButton` / `Ui.IconButton` draws it as a button; `style: accent` emphasises) |
| `menu` | `text`, `items` (`link`s behind a button; `strong` marks the current) |
| `tabs` | `tabs: [{ text, children, when? }]`, `address?` (the chosen tab in the page address) |
| `image` | `src`, `alt` (required, may be empty) |
| `svg` | `markup`, `alt` (drawn as an image) |
| `value` | `value` (an accessor), `text?`, `to?` — one value, presented as its schema says |
| `list` | `rows` (an accessor), `columns: [{ header?, value, shown?, style? }]` (or `{ type: time, value, relative? }`), `heading?`, `rowStyle?` |
| `markdown` | `value` (an accessor to a string), `annotations?` |
| `time` | `value` (an accessor to a `date` / `date-time` string), `relative?` ("3 hours ago") |
| `button` | `action`, `inputs`, `confirm?`, `prompt?`, `enabled?`, `button?` |
| `bar` | `start?`, `center?`, `end?` — node lists |
| `command` | `command` (a root's command: `!cel "chat.stop"`), `text`, `button?` |
| `query` | `query` (a `Ui.Query`), `content` (over `data`), `loading?`, `failure?` |
| `composite` | `ref` — a `!ref`, or an inline declaration |
| `pane` | `ref` — a `Ui.Pane`, in a layout or page |

Every node also takes `style` (not `tabs`; one or a list of `title`,
`heading`, `subheading`, `muted`, `strong`, `accent`, `danger`, `warning`, `success`),
`when` (a boolean deciding on the server whether the node is delivered),
`shown` (a condition deciding in the browser whether it is drawn — see *Reads and
conditions*) and `fill: true` (reach the page's bottom; the innermost
filling node scrolls; not on menu items).

**Markdown.** A `markdown` node draws CommonMark with GFM; raw HTML is never
inserted. `annotations: { rows, line, count?, action }` puts `action`, a bound
action over each `row` of `rows`, on its 1-based source `line`, `count` a badge.

**Texts.** Every label, heading and node text is in the module's `lang:`. A
text over data names its values (`text: { text: "{$n} tasks", values: { n:
!cel "data.open" } }`; plurals are `{ plural: n, cases: { one, other } }`).

**Addresses.** A page `path`, an `href`, an `image`'s `src`, a `basePath` and a
request target's `path` are app-relative (`/` then anything but `/` or `\`),
resolved under the mount: at `/admin`, `/api/reports` is `/admin/api/reports`.
An `href` may also start `https://`, `http://` or `mailto:`, a `src` `https://`
or `http://`.

An `href` or request target is a string, or
`{ path, pathParams, queryParams }`: `path` a template whose `{name}`
placeholders are whole segments (`/tasks/{id}`), filled from `pathParams`
(accessors or literals, percent-encoded); `queryParams` the query (null and
empty left out). An `href`'s `path` may be a `!ref` to a `Ui.Page`. An unbound
placeholder or unused `pathParams` entry is refused by `telo check`. A
parameter may read a nullable value: null leaves the address unresolved.

**Where a press goes.** `to` holds a destination: `{ kind: Ui.Navigate, href }`
moves to an address; `{ kind: Ui.OpenPage, page: !ref <page>, pathParams?,
queryParams?, surface? }` opens a listed page over this one in any
`Ui.Surface` (`Ui.Dialog` when omitted; `address: { name: post }` keeps it as
`_telo.open.post`). `to` sits on
`link`, menu items, `value`, `list` and table columns, relations,
`Ui.CollectionOptions`, navigation `link` entries and `onSuccess`. A region —
`box`, `stack`, `columns`, a listing's records, `CrudUi.Admin`'s rows — takes
`press: { to, label }`, `label` a required text (`{ text: "Open {$title}",
values: { title: !cel "row.title" } }`). A destination reads only the roots
bound where it is written.

**Per request.** In a page's `children` and a layout's regions, `when` and leaf
values (`text`, `src`, `alt`, `markup`, `style`; never a `to`) may be `!cel` over
`request.headers` (lower-case; test with `in`) and `request.ip`.

## Shapes first

Every listing, form, filter bar and action is drawn from a `Telo.JsonSchema`
shape. Give the same shapes to the routes and the screen, so a rename is a
`telo check` error. A property's `title` is its label and column header;
`type`, `format` and `enum` decide how it is entered and shown.

```yaml
kind: Telo.JsonSchema
metadata: { name: NewTask }
schema:
  type: object
  required: [text]
  additionalProperties: false
  properties: { text: { type: string, title: Task, minLength: 1 }, status: { title: Status, enum: [open, blocked, done] }, dueOn: { type: string, title: Due, format: date } }
```

`Task` is `NewTask` (`extends:`) plus a required `id`.

## Collections and listings

What a list accepts is declared, never inferred. A `DataModel.Collection`
(module `data-model`) holds the record `model`, its `key` (default `id`),
`query: { filters, sort, facets?, search? }` (`filters` and `sort` required,
`[]` for none) and `relations`. A filter is `{ property, operator }`, operator one of
`eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`, `absent` (null or missing;
only on an optional property). A facet is a property whose present values, with
counts, the endpoint answers. `search: { properties }` (string properties, at
least one) lets `search=<text>` match any of them, ignoring case. A relation says a property holds
another collection's key (`authorId: { collection: !ref authors }`); the target
must accept `in` on its key.

```yaml
kind: DataModel.Collection
metadata: { name: posts }
model: !ref Post
query:
  filters: [{ property: title, operator: contains }, { property: authorId, operator: eq }, { property: status, operator: in }]
  sort: [{ property: title }]
  facets: [{ property: authorId }]
relations: { authorId: { collection: !ref authors } }
```

A `Ui.CollectionSource` is a collection as the browser reaches it
(`collection`, `basePath`); a `Ui.CollectionPresentation`
shows it (a relation becomes a name in a column, a filter's choices, a picker):
`source`, and `relations: { <property>: { source, label, hint?, to?, search?,
pageSize? } }` — `label`, `hint` and `to` read `row`, the related record. A
presentation holds no keys: a related value is always the target's `key`.

A `Ui.Listing` draws records: `presentation`, `model` (row shape), `filters`
(fixed equalities), `query`, `pageSize`, `paging`, `rowStyle`, `create` / `edit` (presses), `delete`, `rowActions`, `empty`, `layout` (a kind under `Ui.ListingLayout`; default `Ui.TableLayout`, a column
per model property but the key) and `compact` (the layout below `compactBelow`). Also `sort: { by?: { property,
direction }, choosable }` (`choosable: false` fixes the order), `show: { count }` and
`rowActionsDisplay`. `press` says what pressing a
record does (left out, it does what `edit` does).

- Layouts: `Ui.TableLayout` (`columns`), `Ui.ListLayout`, `Ui.CardLayout`
  (`content`, `size`), `Ui.BoardLayout` (`groups`), `Ui.CalendarLayout` and
  `Ui.TimelineLayout` (`span: { start, end? }`), `Ui.TreeLayout` (`parent`),
  each with `content`, `move`; only its own keys.
- `groups: { property, values: all | present }` reads one list per value;
  `present` uses the facet request; `span` and `parent` become range and parent
  filters. `telo check` refuses a layout the collection cannot serve (an
  unknown property, a missing `eq`, range or `parent` filter, `present` off
  `facets`). `Ui.ListLayout` takes `frame` (`framed` | `flush`).
- `move` is a `Ui.Move` over `row` and `to`: dragging a card or event runs it.
- `row.<property>` in a `value`, a style rule's `by` or a `props` entry is an
  accessor: a plain chain or a literal. A data-dependent style is a rule
  `{ by, cases, default? }`.
- A column sorts when its value is `row.<property>` and `query.sort` lists it.

**The collection contract** — what `basePath` must answer:

- `GET <basePath>?limit=&cursor=&sort=` plus `<property>=` and
  `<property>.contains|gt|gte|lt|lte|in=` (`in` repeated per value) and
  `<property>.absent=true|false`, answering `{ rows, total, next }` (`next`
  null on the last page). `?facet=<property>` plus filters answers
  `{ values: [{ value, count }], next }`.
- `POST <basePath>` creates; `GET`, `PATCH` (merge patch; `null` clears) and
  `DELETE <basePath>/<key>` read, edit and delete one record; an `ETag` is
  sent back as `If-Match`, a 412 keeps the form's input.
- A create body holds only properties with a value; a wrong JSON type is a 400.
- Errors are `application/problem+json`; a 400's `data.issues` are `{ pointer,
  keyword, params }`, one at `/body/<property>` marks that field.
- Query keys `limit`, `cursor`, `sort`, `facet`, `search` and `_telo…` are reserved.

Over one SQL table, `Crud.Api` speaks it (*An admin screen over one table*).
Over any SELECT, a route's handler `Crud.Reader` does: `connection`,
`collection`, `select: !sql` (columns aliased to the model's properties) and
the route's `inputs` (`filters`, `sort`, `facet`, `limit`, `cursor`, and
`scope: { worker: !cel "request.params.name" }`, equalities the route fixes; a
client filter on one is a 400).

## Filter bars — `Ui.Filters`

A filter bar is a container: every listing in its `content` obeys it.

```yaml
kind: Ui.Filters
metadata: { name: taskFilters }
presentation: !ref tasksPresentation
fields:
  - { property: text, operator: contains, pinned: true }
  - { property: status, operator: in, control: options, default: [open, blocked] }
  - { property: ownerId, operator: eq, values: present }
  - { property: dueOn, operator: gte }
presets: [{ label: Blocked, values: [{ property: status, operator: in, value: [blocked] }] }]
policy: { placement: { kind: Ui.CollapsiblePlacement, show: chosen, summary: chips }, state: { key: tasks, address: true, store: { kind: Ui.LocalStore } } }
content: { type: composite, ref: !ref taskList }
```

- A `date` / `date-time` filter's `default` and a preset's value may be
  relative, `{ unit: day, offset: -1 }`, resolved at each first-page read.
- `fields` left out is one control per collection filter. A listed field is a
  `{ property, operator }` pair the collection declares, plus optional
  `pinned` (matters only where the bar folds), `control` (`auto`, `select`,
  `options`, `toggle`, `slider`, `tags`, `none`) and `default` (one value, a
  list under `in`, `true` under `absent`).
- A field over a related property offers the related records, labelled by the
  presentation's relation. `values: all` (default) offers every one; `present`
  only those occurring under the bar's other filters, with counts, and needs
  the property under the collection's `facets`. `options` overrides the source.
- `policy`'s choices combine freely: `apply`, `placement`, `state`. The display
  options (`show`, `controls`, `summary`) sit on the placement that draws
  controls; a `compact` placement inherits omitted ones.
- **Placements and stores are kinds**: `Ui.AbovePlacement` (default),
  `Ui.AsidePlacement`, `Ui.CollapsiblePlacement`, `Ui.OverlayPlacement`,
  `Ui.SearchBoxPlacement`; `Ui.LocalStore`, `Ui.SessionStore`. A `state` keeps
  the bar's values in the address (`address: true`), a store, or both.
- `search: { pinned?, default? }` adds a text search (sent as `search`, first
  among the controls). Left out, a bar without `fields` has it when the
  collection declares `query.search`; a bar with `fields` only by writing it.
- `Ui.SearchBoxPlacement` (`placeholder?`) is one box, filters as chips; it
  takes no `show`, `controls`, `summary` or `compact`.

## Forms and where they open — `Ui.Form` and surfaces

A `Ui.Form` names a `model` (write shape) and `record: { presentation, key? }`,
the presentation whose source it writes to and, to edit, a chain to the stored
record's key; `fields` left out is one field per enterable property (a
scalar, or a list of scalars). An entry is a property name (control derived
from the model) or a **field kind**: `Ui.InputField` (`control: select | options |
toggle | slider | tags`), `Ui.ChoiceField` / `Ui.PickerField` over an option
source, `Ui.DateRangeField` (`presets`, `initialPreset`). `telo check` refuses a control the property cannot take.

```yaml
fields: [title, { kind: Ui.PickerField, property: ownerId, options: !ref people, group: who }, { kind: Ui.DateRangeField, property: period }]
groups: [{ name: who, label: People }]
---
kind: Ui.CollectionOptions
metadata: { name: people }
model: !ref Person
value: !cel "row.id"
label: !cel "row.name"
source: !ref peopleSource
filters: { team: !cel "values.team" }
search: { property: name, operator: contains }
```

`value` is a property the collection filters with `in`; `filters` may read `values`. A relation property is entered with a picker unless you write
the field. `groups` keep fields together; `state: { key, address? }` keeps
values in the address or a store.

A record's screens are **pages**. The edit page reads the record in a `query`
node and holds the form; the listing's `create` / `edit` open the pages:

```yaml
kind: Ui.Page
metadata: { name: taskPage }
path: /tasks/{id}
children:
  - type: query
    query: { kind: Ui.Query, model: !ref Task, url: { path: "/api/tasks/{id}", pathParams: { id: !cel "params.id" } } }
    content:
      - type: composite
        ref: { kind: Ui.Form, model: !ref NewTask, record: { presentation: !ref tasksPresentation, key: !cel "data.id" }, initialValues: !cel "data" }
---
kind: Ui.Listing
metadata: { name: taskTable }
presentation: !ref tasksPresentation
model: !ref Task
create: { to: { kind: Ui.OpenPage, page: !ref newTaskPage, queryParams: { status: !cel "values.status" } } }
edit: { to: { kind: Ui.OpenPage, page: !ref taskPage, pathParams: { id: !cel "row.id" }, surface: { kind: Ui.Panel, address: { name: task } } } }
```

- The create page holds the same form with `record: { presentation }` (no
  `key`: it `POST`s), `afterSubmit: again` and `initialValues: !cel "query"`;
  its `query: { title: { type: string }, … }` declares every property the
  model requires. `create` binds `values` (what a board column proposes, `{}`
  from the listing's button) for `queryParams`.
- `key` is held to the collection's key type and makes the form `PATCH` the
  changed properties; the form is held to the collection's `schemas.update` /
  `schemas.create` (`UI_WRITE_*`) and owns `afterSubmit` (`close`, `keep`,
  `again`) and `unsaved` (`confirm`, `discard`).
- `surface` is a **kind**: `Ui.Dialog` (default), `Ui.Drawer`, `Ui.Popover`,
  `Ui.InlineSurface`, `Ui.Panel`; `address: { name }` reopens it after a
  reload, `compact` is the overlay below `compactBelow`.
- Entries sharing a `state` key hold a kept property as one value.
- **`ui` owns every default.** Leave a key out; never restate a default.

## Writes — `Ui.Mutation` and its calls

`Ui.Mutation` is a write and draws nothing: `inputModel`, `outputModel?`,
`method` (`POST` default, `PUT`, `PATCH`, `DELETE`), `url` (an address over
`input`), `invalidates?`, `concurrency?`. It is reached by URL only — no `!ref`
to a handler. Give route and mutation the **same two `Telo.JsonSchema` shapes**:

```yaml
kind: Ui.Mutation
metadata: { name: generate }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
url: /api/reports
invalidates: [/api/reports]
```

The route answers the **mutation contract**: a 2xx with a JSON object valid
against `outputModel` (read only when a `result` tree, effect or `invalidates`
does), a problem for any failure. An `Http.Api` route's `request.schema.body`
takes the JSON Schema inline (a `!ref` there fails at boot): keep it equal to
`inputModel`.

- `url` reads `input`: `/api/tasks/{id}` with `pathParams: { id: !cel
  "input.id" }`. An input read as exactly `input.<property>` is consumed: it
  travels in the url, not the body. `DELETE` sends no body and must consume
  every input property. A 204 is a success unless something reads `result`.
- After a 2xx the url, `invalidates` targets and a listing's `basePath` are
  announced; every reader of exactly that path (`Ui.Query`, `Ui.Listing`,
  `Ui.Chat`) reads again. A segment may be `*` (one) or `**` (any).
- `concurrency: serial` runs every call of it in turn.

A **call** runs one where it is placed: `Ui.MutationCall` is `{ mutation,
inputs, label, confirm?, prompt?, enabled?, onSuccess?, onFailure?, result?, failure? }` —
`rowActions` on a listing or `list`, `annotations.action`, and the `action` of a
`button` node (`inputs: {}` for a mutation taking nothing). A layout's `move` is
a `Ui.Move`: no `label`, no `result`.

```yaml
rowActions:
  - mutation: !ref reject
    inputs: { id: !cel "row.id", note: !cel "prompt.note" }
    label: Reject
    prompt: { kind: Ui.Prompt, model: !ref RejectNote }
    onSuccess: [{ kind: Ui.Navigate, href: /tasks }]
```

- `inputs` binds every required input with matching types, over `row`,
  `params`, `query`, `data`, `prompt`; `inputModel` reads it as `input`.
- `confirm` asks first; `prompt` is a `Ui.Prompt { model, fields?, groups? }`, a
  dialog whose entries `inputs` reads as `prompt.<name>`. `enabled` is a
  condition with `disabledText`.
- `result:` is a node tree over `result` (typed from `outputModel`; with none,
  `result.<member>` is `CEL_UNKNOWN_FIELD`) and `input`, drawn where the call
  ran; `failure:` over `error` (`status`, `code`, `message`) and `input`, left
  out it shows code and message.
- `onSuccess` is a list of effects (`Ui.Navigate`, `Ui.OpenPage`, `Ui.Toast`,
  `Ui.Close`) over `result` and `input`, run in order by the page; `onFailure`
  is the same list over `error` and `input` when the write does not succeed.

### Forms that write, and reads that follow them

A `Ui.Form` is a record editor (`record`), a mutation form or free-standing.
`onSubmit: { mutation, inputs, label?, confirm?, enabled?, result?, failure? }`
runs a write when pressed (`inputs` read `values`, `params`, `query`); the form's
`onSuccess` effects follow `afterSubmit`, over `values` and `result`; its
`onFailure` runs over `values` and `error` after a submit write fails. `autosave:
{ mutation, inputs, debounce? }` saves as values settle and must replace (`PUT`;
a `POST` is refused); `clearAnswerOn` clears answers. `record` excludes both.

A `Ui.Query` or `Ui.Listing` with `form: !ref f` reads the form's settled valid
record as `form` (`body: { period: !cel "form.period" }`): a live preview
needs no button.

## Toasts

A toast reports an event ("Apollo archived"); a state stays drawn where it holds, so keep the call's `failure:` tree and offer Undo where the record lives too.

```yaml
onSuccess:
  - kind: Ui.Toast
    text: { text: "{$name} archived.", values: { name: !cel "result.name" } }
    call: { label: Undo, mutation: !ref restoreProject, inputs: { id: !cel "result.id" } }
```

## Reads and conditions — `Ui.Query`

Data a screen needs when it opens is a `Ui.Query` (`model`, `url` an address
over `query` and `params`, optional `query`, `reloadOn`, `reloadEvery`), drawn
by a `query` node. A sign-in gate is an inline query plus conditions:

```yaml
- type: query
  query:
    kind: Ui.Query
    model: !ref Auth
    query:
      signin: { type: string, enum: [denied, expired] }
    url: { path: /api/auth, queryParams: { reason: !cel "query.signin" } }
    reloadOn: [focus, unauthorized]
  content:
    - { type: value, value: !cel "data.email", shown: { at: !cel "data.authorized", matches: { const: true } } }
    - { type: text, text: Sign in., shown: { at: !cel "data.authorized", matches: { const: false } } }
```

- A named query (`metadata: { name: session }`) several nodes place (`query:
  !ref session`) is one request; each node draws its own trees.
- `input: { method?, model, body }` sends `body`, a map or list of plain chains
  over `query` / `params` or literals typed by `input.model` (an empty chain
  drops its member), as `QUERY` (route `method: QUERY`) or `POST`.
- `shown` on the node (over `query`) holds back drawing and reading until it
  holds.
- `loading` / `failure` left out, `ui` fills them. `reloadEvery: 30s` (at least
  `5s`; also on `Ui.Listing`) reads on a timer, `reloadOn: [focus]` on window
  focus, `[unauthorized]` on a 401 in the node's trees.
- A condition is `{ at, matches }`: `at` a plain chain over the roots in
  scope, `matches` a schema in a closed profile (`type`, `const`, `enum`,
  `not`, `allOf`, `anyOf`, `required`, `properties`, `items`, `minItems`, length and numeric bounds, `pattern`). A missing value never matches, even under `not`; test absence on the
  parent: `{ at: !cel "data", matches: { not: { required: [email] } } }`.
- Roots: `data` (a query node's `content`), `error` (its `failure`), `query`,
  `params`, `values` (a form's or action's fields), `row` (a `list` column).
  Only a condition, a `value` / `list` / `command` node or an address's params
  read one.
- A field's `shown` reads `values`: a hidden field is not sent, but a required
  property still blocks submitting. An action's `enabled: { at, matches,
  disabledText }` disables its button until it holds.
- A `list` draws one answer's rows, unpaged; a growing set is a listing.

## A chat — `Ui.Chat`, beside a list of conversations

One composite, no conversation list. A `Ui.ConversationSource` pairs a
`Conversation.Conversation` (`ai-chat`'s) with its `basePath`; `Ui.Chat` names
it plus `placeholder`, `starters`, `show`, `composer`, `buttons` and `header` (nodes over
`conversation` and `chat`'s commands `exportTranscript`, `copyTranscript`,
`stop`, `newConversation`; default a `bar` holding export, `[]` none).

- `conversation: { parameter: conversation }` follows that query parameter;
  omitted, the choice is in memory. `invalidates: [/api/chat/conversations]` re-reads that
  path when a send is admitted and a turn ends.
- Mount
  `{ kind: Chat.Api, conversation: !ref … }` at the same `basePath`; import
  `ai-chat` as `Chat`, never `AiChat`.
- The list is a `Ui.SplitView`: `aside.actions` a button `link` (New
  conversation), `aside.content` a `Ui.Listing` over a `Ui.CollectionSource` for
  `Conversation.conversations`
  (`basePath: /api/chat/conversations`, `model: !ref
  Conversation.ConversationSummary`), `delete: true`, rows linking with
  `queryParams: { conversation: !cel "row.id" }`, rename / archive as `PATCH`
  row actions; the chat is `content` with `fill: true`.

### Ui.SplitView

A composite placing `aside` by `content`; `aside` is the `Ui.Aside` a layout's
is: `side`, `size`, `label` (required), `collapse` (with a kept `state`),
`compact` (default a `Ui.Drawer`), `frame`, `toggle`, `actions?`, `content`.
Trees hold no root: put `value` / `list` in a composite that declares one.

## An admin screen over one table — `crud` and `crud-ui`

Over one SQL table, `crud` (no `ui`) and `crud-ui` (`crud` and `ui`) give both
halves from one declaration.

- `Crud.Collection` is a `DataModel.Collection` (with `relations` and
  `query.facets`) over a `table`, an `Sql.Table` whose primary key is `id`,
  holding `model` and `schemas: { list, create, update }`, all required: `model`
  and `list` declare a required `id`; `create` and `update` leave it out. A
  relation contradicting the table's foreign key is refused before the app runs.
- `Crud.Api` mounts list / read / create / patch / replace / delete over `collection:`
  (the whole collection contract; declare the table in your SQL backend).
- `CrudUi.CollectionSource` is a `Ui.CollectionSource` over a `Crud.Collection`
  (`collection`, `basePath`).
- `CrudUi.Admin` is the whole screen (filter bar, sortable paged listing,
  create and edit presses, confirmed delete) from `source` and, optionally,
  `relations`, `filters` (the bar's `policy`), `create` and `edit` (presses to
  your pages; no form is generated), `press`, `paging`, `layout` and `compact`; a key left out
  takes the listing's default.

```yaml
kind: Crud.Collection
metadata: { name: tasks }
table: !ref tasksTable
model: !ref Task
schemas: { list: !ref Task, create: !ref NewTask, update: !ref NewTask }
query: { filters: [{ property: text, operator: contains }, { property: status, operator: in }], sort: [{ property: dueOn }] }
---
kind: CrudUi.CollectionSource
metadata: { name: tasksSource }
collection: !ref tasks
basePath: /api/tasks
---
kind: Crud.Api
metadata: { name: tasksApi }
connection: !ref db
singular: task
plural: tasks
collection: !ref tasks
```

Place it as a page child: `type: composite`, `ref: { kind: CrudUi.Admin,
source: !ref tasksSource }`.

A board's `move` names an action over a route of your own. Import `ui` too to
name a layout or surface.

**When to hand-build instead.** `CrudUi.Admin` has no key for chosen columns,
a row style, a page size, fewer filters, a filter's `pinned` / `control` /
`default` / `values`, presets or row actions. Replace it with a
`Ui.CollectionPresentation`, the create and edit pages, a `Ui.Listing` over the
`list` shape and a `Ui.Filters` holding it.

## Themes, styling and custom components

- **Theme and brand are two keys.** `theme:` is one `UiReact.Theme` (the look,
  optionally control sets): `!ref UiReact.defaultTheme`, another module's
  theme, or `{ kind: UiReact.Theme, stylesheets: [!module-path ./look.css] }`. `tokens:` is the brand over it: a
  `Ui.DesignTokens` of a closed set (`color.*`, `radius.*`, `space.*`,
  `font.*`, `width.page`, …), each a CSS value string, or a list of `{ tokens, when? }`.
- **Control sets.** A theme's `controls` lists `UiReact.Controls` sets, each
  declared by the library shipping its browser entry; no two implement one
  control. The fifteen inline controls may be replaced in any subset, the ten
  layer controls (selects, menus, dialogs, drawers, popovers, …) only as one unit. `ui-react-radix` exports `theme`.
- **Stylesheets.** Everything drawn carries `data-telo-part`; your unlayered
  `stylesheets` win.
- **Custom components.** A library ships a browser entry (`abi: ui_react-1`: a
  named export that is a React function component) and publishes it as an
  instance of `Ui.ComponentExport` (`entry`, `export`, `props` as a shape). An
  application places it with `Ui.Component` (`component: !ref <Alias>.<export>`,
  `props`, `model` when a prop reads `row`), on a page or as a table column
  `cell`; props are checked against the shape. The entry may leave only
  `react`, `react/jsx-runtime`, `react-dom` and `@telorun/ui-react` `external`. `useHost()` from
  `@telorun/ui-react` gives `location`, `navigate`, `href`, `fetch`,
  `notifyChanged(path)` and `onChanged(path, listener)`.
- **Your own listing layout.** A component for `ui_react_layouts-2` is drawn by
  `Ui.ComponentLayout` (`component`, `props`, the `groups` / `span` / `parent`
  plan); it places each `record.press` first in the element it covers.
- **Reusable sections.** `Ui.View` holds one node tree (`content`).

## Manifests wire no events

There is no `onClick`: a write is a `Ui.Mutation`. Requests carry the page's
same-origin credentials; guard the routes.

## A desktop app

Keep the application deployable and wrap it: a second `Telo.Application` runs it with `App.Instance`, declares a `Telo.DesktopHost` need and opens a `Desktop.Window` per screen at its `path`; a tray app adds `Desktop.TrayIcon`. `get_kinds` gives the fields.

## Testing a screen

Start the app with `App.Instance` (module `app`) in a `Telo.Sequence`'s `with:`
and request its documents:

- `<mount>/_telo/ui/app` is the application document (`layout` ids);
  `<mount>/_telo/ui/layout?id=<id>` a layout's `header`, `aside`, `footer`;
  `<mount>/_telo/ui/page?path=<page path>` one page's document, its
  `children` the resolved nodes — `listing`, `form`, `action`, `filters`,
  `component`, or `error` with a `code` where a node could not be produced.
- Assert node types, a listing's layout and `rowActions`, an action's
  `request`/`fields`; call the routes with what the page would send, a refused
  400 too. Give each test its own port.

## Before you finish

- `telo check` is clean.
- Every listing, filter bar and action names a route answering its contract.
