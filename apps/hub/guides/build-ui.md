# Building a user interface

A Telo application's screens are declared in its manifest, never written as a
frontend. The `ui` module is the vocabulary — pages, listings, forms, actions,
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
  `ui`, `ui-react`, `http-server`, `data-model` and — for a generated admin
  screen — `crud` and `crud-ui`. A `Telo.*` kind is built in and needs no import.
- **The API comes first.** A screen calls routes; it never reaches a database
  or an invocable directly. Declare the routes, then the screen over them.

## When a screen is the answer

Reach for `ui` when a person needs to browse, filter, create, edit or delete
records, or press a button that runs an operation. For a static page or an
HTML email, use a template or HTML module; for a machine, the API alone.

Who imports what:

- The **application** imports `ui`, `ui-react` and `http-server`, mounts the
  renderer's application on its server, and owns the pages.
- A **library** that describes the interface of its own domain imports `ui`
  alone and exports composites (a listing, a form, a `Ui.View`) as instances.
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
once is declared inline at its node (`ref: { kind: Ui.Listing, … }`); `taskTable`
below is named because a page and a filter bar both use it.

- `title` (required) names the application. `words` (required) is what the
  renderer draws on its own — `!ref Ui.words`, English. `theme` (required) is
  the look — `!ref UiReact.defaultTheme`, or another theme. `pages` (at least
  one) are `Ui.Page`s — `{ path, title, query?, width?, children }`, each path
  unique — inline or `!ref`, a library's included.
- `navigation: { items, placement? }` is the menu, naming pages by `!ref`,
  never by path: `{ type: page, page, text? }`, `{ type: link, text, href }`,
  `{ type: group, text, items }`, each with `when?` and `icon?` (a
  `UiLucide.Icon` from module `ui-lucide`, or a `Ui.FileIcon`). Omitted, one
  entry per page. A page entry naming a page `pages` does not list is refused
  by `telo check`. `placement` is a kind: `Ui.HeaderNavigation` (default),
  `Ui.SidebarNavigation` (`side`, `rail`, `store`), or a compact one —
  `Ui.OverlayNavigation`, `Ui.TabBarNavigation` — which a header's or a
  sidebar's `compact` names for a narrow screen.
- Optional: `translator` (an `I18n.Translator`) and `lang` (a tag, or `!cel`
  over `request.headers`) serve every text translated; `tokens` (the brand),
  `stylesheets` (`!module-path ./ui.css`), `compactBelow` (the narrow-viewport
  breakpoint), `pageWidth` (`contained` or `full`; a page's `width` wins),
  `header: { start?, end?, width? }` (nodes on every page).

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
conditions"). There is no spacing field (gap, alignment, width): that is the
renderer's styling.

**Texts.** Every label, heading and node text is a text in the module's
`lang:`. A text over data names its values (`text: { text: { plural: n,
cases: { one: "{$n} open task", other: "{$n} open tasks" } }, values: { n:
!cel "data.open" } }`), so a translation chooses the plural.

**Addresses.** An address inside the application — a page `path`, a `link`'s
`href`, an `image`'s `src`, a collection's `basePath`, an action's `source.path` —
is app-relative: `/` followed by anything but `/` or `\`, with no control
character: `//host` and `/\host` are refused. A `link` may also start
`https://`, `http://` or `mailto:`; an `image`, `https://` or `http://`. An app-relative address
resolves under the mount: at `/admin`, `source.path: /api/reports` is requested
at `/admin/api/reports`, so serve the API there.

**Per request.** Inside a page's `children` and `header`, a node's `when` and its leaf
values (`text`, `href`, `src`, `alt`, `markup`, `style`) may be `!cel`,
evaluated for every request against `request.headers` (lower-case names; test
with `in` first) and `request.ip`:

```yaml
- { type: text, text: !cel "'Signed in from ' + request.ip", style: muted }
```

The tree's structure and every `ref` stay literal: a computed `children` list
or `ref` is `REF_SLOT_COMPUTED`. A value that is no valid node once evaluated
becomes an `error` node for that request.

## Shapes first

Every listing, form, filter bar and action is drawn from a JSON Schema shape — a
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

Shapes share properties through `extends:`.

## Collections and listings

What a list accepts is declared, never inferred from a row's types. A
`DataModel.Collection` (module `data-model`, no renderer) holds the record
`model`, its `key` (default `id`), `query: { filters, sort, facets? }` — both
`filters` and `sort` required, `[]` for none — and `relations`. A filter is
`{ property, operator }`, operator one of `eq`, `contains`, `gt`, `gte`, `lt`,
`lte`, `in`, `absent` (null or missing; only a property the model leaves
optional). A facet is a property whose present values, with counts, the
endpoint answers. A relation says a property holds another collection's key
(`authorId: { collection: !ref authors }`); the target must accept `in` on its
key. Relations may point at the collection itself or at each other.

```yaml
kind: DataModel.Collection
metadata: { name: posts }
model: !ref Post
query:
  filters:
    - { property: title, operator: contains }
    - { property: authorId, operator: eq }
    - { property: status, operator: in }
  sort: [{ property: title }]
  facets: [{ property: authorId }]
relations:
  authorId: { collection: !ref authors }
```

The screen side adds three small resources. A `Ui.CollectionSource` is a
collection as the browser reaches it (`collection`, `basePath`); write one
authors source and every screen and picker over authors uses it. A
`Ui.CollectionPresentation` is how one set of screens shows a collection:
`source`, and `relations: { <property>: { source, label, hint?, href?, search?,
pageSize? } }` — `label`, `hint` and `href` read `row`, the related record. A
presentation holds no keys: a related value is always the target's `key`.

```yaml
kind: Ui.CollectionPresentation
metadata: { name: postsPresentation }
source: { kind: Ui.CollectionSource, collection: !ref posts, basePath: /api/posts }
relations:
  authorId:
    source: !ref authorsSource
    label: !cel "row.name"
    search: { property: name, operator: contains }
```

A relation makes a listing column show the author's name, a filter field offer
authors by name, and a form enter the author with a picker.

A `Ui.Listing` draws the records: `presentation`, `model` (the row shape),
`filters` (fixed equalities), `query`, `pageSize`, `paging` (`pages`, `more`,
`scroll`), `rowStyle`, `create` / `edit`, `delete`, `rowActions`, `empty`,
`layout` and `compact`. `layout` is a kind under `Ui.ListingLayout`; omitted,
it is `Ui.TableLayout` with a column per model property but the key.

```yaml
kind: Ui.Listing
metadata: { name: postsList }
presentation: !ref postsPresentation
model: !ref Post
paging: more
delete: true
layout: { kind: Ui.BoardLayout, groups: { property: status }, move: { action: !ref setStatus, inputs: { id: !cel "row.id", status: !cel "to.status" } } }
compact: { kind: Ui.CardLayout, size: small }
```

- Layouts: `Ui.TableLayout` (`columns`), `Ui.ListLayout` and `Ui.CardLayout`
  (`content`, cards `size`), `Ui.BoardLayout` (`groups`), `Ui.CalendarLayout`
  and `Ui.TimelineLayout` (`span: { start, end? }`), `Ui.TreeLayout`
  (`parent`, a property relating the collection to itself), each with
  `content` and `move`. A layout takes only its own keys.
- `groups: { property, values: all | present }` reads one list per value;
  `present` uses the facet request. `span` and `parent` become range and
  parent filters. `telo check` refuses a layout the collection cannot serve:
  an unknown property, or a missing `eq`, date-range or `parent` filter, or
  `present` on a property not under `facets`.
- `compact` is the layout used below `compactBelow`; an open edit form
  survives the swap. `paging` follows both; boards and trees always load more.
- `move` is a row action over `row` and `to` (the record as the gesture leaves
  it): dragging a card, rescheduling an event or reparenting a tree item runs
  the action, never a form replace. Each record also has a "Move to" menu.
- A map or seat plan is `Ui.ComponentLayout` (`component`, `props`, and the
  `groups` / `span` / `parent` plan): the renderer fetches, pages and reloads;
  the component, written for the layout ABI, draws the records.
- `row.<property>` in a `value`, a style rule's `by` or a `props` entry is an
  accessor: a plain chain or a literal, no call or operator. A data-dependent
  style is a rule `{ by, cases, default? }`.
- A column sorts when its value is `row.<property>` and `query.sort` lists it.

**The collection contract** — what `basePath` must answer:

- `GET <basePath>?limit=&cursor=&sort=` plus `<property>=` and
  `<property>.contains|gt|gte|lt|lte|in=` (`in` repeated per value) and
  `<property>.absent=true|false`, answering `{ rows, total, next }`; `next` is
  `null` on the last page. `?facet=<property>` plus filters answers
  `{ values: [{ value, count }], next }`.
- `POST <basePath>` creates; `GET`, `PUT` and `DELETE <basePath>/<key>` read,
  replace and delete one record. `PUT` replaces the whole record.
- A write body holds only properties that have a value; a `null` or wrong
  JSON type is a 400 naming it. A row read is valid against the model.
- Errors are `application/problem+json`; a 400's `data.issues` are
  `{ pointer, keyword, params }`, one at `/body/<property>` marks that field.
- Query keys `limit`, `cursor`, `sort`, `facet` and `_telo…` are reserved.

Over one SQL table, `Crud.Api` speaks it for you (*An admin screen over one
table*).

## Filter bars — `Ui.Filters`

A filter bar is a container: every listing inside its `content` obeys it,
whatever the layout.

```yaml
kind: Ui.Filters
metadata: { name: taskFilters }
presentation: !ref tasksPresentation
fields:
  - { property: text, operator: contains, pinned: true }
  - { property: status, operator: in, control: options, default: [open, blocked] }
  - { property: ownerId, operator: eq, values: present }
  - { property: dueOn, operator: gte }
presets:
  - label: Blocked
    values:
      - { property: status, operator: in, value: [blocked] }
policy:
  show: chosen
  summary: chips
  placement: { kind: Ui.CollapsiblePlacement }
  state: { key: tasks, address: true, store: { kind: Ui.LocalStore } }
content: { type: composite, ref: !ref taskList }
```

- `fields` left out is one control per collection filter. A listed field is
  a `{ property, operator }` pair the collection declares, plus optional
  `pinned`, `control` (`auto`, `select`, `options`, `toggle`, `slider`,
  `tags`, `none`) and `default` (one value, a list under `in`, `true` under
  `absent`, which `auto` draws as a toggle).
- A field over a related property offers the related records, labelled by the
  presentation's relation. `values: all` (default) offers every one;
  `values: present` offers only those occurring under the bar's other filters,
  each with its count, and needs the property under the collection's `facets`.
  It works for any faceted property, an enum included. `options` overrides
  where the choices come from.
  `tags`, `none`) and `default` (one value, a list under `in`).
- `policy` is one record of independent choices — `show` (`all` | `chosen`),
  `controls` (`direct` | `chips`), `apply` (`commit` | `typing` | `button`),
  `summary` (`none` | `chips`), `placement`, `state` — and every combination
  is valid.
- **Placements and stores are kinds**, chosen by `kind:` (inline or `!ref`):
  `Ui.AbovePlacement` (the default), `Ui.AsidePlacement`,
  `Ui.CollapsiblePlacement`, `Ui.OverlayPlacement`; `Ui.LocalStore`,
  `Ui.SessionStore`. A `state` keeps the bar's values in the page address
  (`address: true`), a store, or both; left out, they live in memory.
- `pinned` means something only where the bar folds (`UI_FILTER_PINNED_UNUSED`).

## Forms and where they open — `Ui.Form` and surfaces

A `Ui.Form` names a `model` (the write shape) and the `presentation` whose
source it writes to; `fields`
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
source: !ref peopleSource
filters: { team: !cel "values.team" }
search: { property: name, operator: contains }
```

`value` is a property the collection filters with `in` (how a chosen value
is labelled); `filters` may read the form's `values`. A property with a
relation is entered with a picker over it unless you write the field. `groups` keep
their fields together; `state` keeps entered values in the address or a store.

A listing opens a form through `create` and `edit`, each an object — never a
bare form:

```yaml
kind: Ui.Listing
metadata: { name: taskTable }
presentation: !ref tasksPresentation
model: !ref Task
create:
  form: { kind: Ui.Form, model: !ref NewTask, presentation: !ref tasksPresentation }
  surface: { kind: Ui.Drawer, side: end, compact: { kind: Ui.Dialog, size: full } }
  afterSubmit: again
edit:
  form: { kind: Ui.Form, model: !ref NewTask, presentation: !ref tasksPresentation }
  surface: { kind: Ui.Panel, address: { name: task } }
  unsaved: confirm
delete: true
```

- `surface` is a **kind**: `Ui.Dialog`, `Ui.Drawer`, `Ui.Popover` (the three
  overlays), `Ui.InlineSurface`, `Ui.Panel` or `Ui.PageSurface`. Each takes
  only the keys that mean something for it, so an inapplicable key is a
  `SCHEMA_VIOLATION`. `address: { name }` puts the open form in the page
  address so it can be linked; give a listing's `create` and `edit` the **same**
  name, so one query key (`_telo.open.<name>`) holds whichever form is open —
  empty for create, the row's key for edit. `compact` is the dialog or drawer
  used below the application's `compactBelow`.
- `afterSubmit` is `close`, `keep`, and on `create` also `again`; `unsaved`
  is `confirm` or `discard`.
- **`ui` owns every default.** Leave a key out and the listing fills it.
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
      items: { type: object, properties: { name: { type: string, title: File }, url: { type: string, format: uri-reference } } }
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
it), and a problem for any failure. An `Http.Api`
route's `request.schema.body` takes the JSON Schema written inline — a `!ref`
to a `Telo.JsonSchema` there passes `telo check` and fails at boot — so write
the request shape out there and keep it equal to `inputModel`.

- `inputModel` with no properties is a bare button.
- `fields` left out is every enterable input property; every required input
  must be enterable.
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
  `Ui.Listing` over one reads again.
- `concurrency: serial` runs presses one after another (default `parallel`);
  `clearAnswerOn: [<property>]` clears the drawn answer when that input changes.

### Row actions

`rowActions` on a listing — or on a `list` node, anywhere a list is drawn —
puts one button per entry on every row, before edit and delete:

```yaml
rowActions:
  - action: { kind: Ui.Action, inputModel: !ref Archive, source: { path: /api/tasks/archive }, label: Archive }
    inputs: { id: !cel "row.id", reason: tidy-up }
    confirm: Archive this task?
  - { action: !ref reject, inputs: { id: !cel "row.id" }, prompt: true }
```

- `inputs` is the record sent, checked against that action's own
  `inputModel`: it must bind every required input, with matching types
  (`CONTRACT_INPUTS_MISMATCH`, `CEL_TYPE_ERROR`). It reads `row` and the roots
  in scope — a listing's declared `query:`, or the roots of the tree a list sits
  in (`data`, `result`, `values`…).
- `confirm` asks a question first; `prompt: true` opens a dialog — titled
  with `confirm`, else the action's label — for the action's fields the row
  does not bind: optional inputs, such as a reason. `enabled` (a condition
  over `row`, with `disabledText`) governs the row's button; the action's own
  `enabled` does not.
- A pressed row draws its action's `result` in place of the button and its
  `failure` beside it; every listing over the same source `basePath` reloads,
  and the action's `onSuccess` applies too.

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
        - type: text
          text: Sign in to continue.
          shown: { at: !cel "data.authorized", matches: { const: false } }
```

- `loading` / `failure` are node trees too; left out, `ui` fills them.
- `reloadOn: [focus]` reads again on window focus; `[unauthorized]` when any
  request inside `content` answers 401. A form or listing hidden by a condition
  keeps what it holds, so the screen comes back as it was after signing in.
- A condition is `{ at, matches }`: `at` a plain chain over the roots in
  scope, `matches` a schema in a closed profile (`type`, `const`, `enum`,
  `not`, `allOf`, `anyOf`, `required`, `properties`, `items`, `minItems`,
  `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, numeric
  bounds). A missing value never matches, even under `not`; test absence on
  the parent: `{ at: !cel "data", matches: { not: { required: [email] } } }`.
- Roots: `data` (a reader's `content`), `error` (its `failure`), `query`,
  `values` (a form's or an action's fields), `row` (a `list` column). Each is
  read only by a condition, a `value` / `list` node or `source.params` — never
  by `!cel` text or `when`, which read `request` on a page instead.
- A field's `shown` reads `values`: a hidden field is not sent, but a
  property the model requires still blocks submitting. An action's
  `enabled: { at, matches, disabledText }` disables its button until it holds.
- A `list` draws the rows of one answer and never pages; a growing set is a
  `Ui.Listing`.

## An admin screen over one table — `crud` and `crud-ui`

When the screen is a listing of records over one SQL table, two modules give
both halves from one declaration. `crud` imports no `ui`; `crud-ui` imports
`crud` and `ui`.

- `Crud.Collection` is a `DataModel.Collection` (so it takes `relations` and
  `query.facets`) over a `table`, an `Sql.Table` reference whose primary key
  is `id`. It holds `model` and `schemas: { list, create, update }`, all
  required: `model` and `list` declare a required `id`; `create` and `update`
  leave it out. A relation that contradicts the table's foreign key is refused
  before the app runs.
- `Crud.Api` mounts list / read / create / replace / delete over
  `collection:`, speaking the collection contract, facets and `absent`
  included. It does not create the table: declare it with your SQL backend.
- `CrudUi.CollectionSource` is a `Ui.CollectionSource` over a
  `Crud.Collection` (`collection`, `basePath`).
- `CrudUi.Admin` is the whole screen — filter bar, sortable paged listing,
  create and edit forms, confirmed delete — from `source` and, optionally,
  `relations` (as on a presentation), `filters` (the bar's `policy`), `create`
  and `edit` (`{ surface?, afterSubmit?, unsaved? }`), `paging`, `layout` and
  `compact`. It declares no default: a key left out takes the listing's.

```yaml
kind: Crud.Collection
metadata: { name: tasks }
table: !ref tasksTable
model: !ref Task
schemas: { list: !ref Task, create: !ref NewTask, update: !ref NewTask }
query:
  filters:
    - { property: text, operator: contains }
    - { property: status, operator: in }
  sort: [{ property: dueOn }]
---
kind: CrudUi.CollectionSource
metadata: { name: tasksSource }
collection: !ref tasks
basePath: /api/tasks
---
kind: Crud.Api            # mounted on the server at the path basePath is under
metadata: { name: tasksApi }
connection: !ref db
singular: task
plural: tasks
collection: !ref tasks
```

Placed as a page child:

```yaml
type: composite
ref:
  kind: CrudUi.Admin
  source: !ref tasksSource
  filters: { show: chosen, summary: chips, state: { key: tasks, address: true } }
  create: { surface: { kind: Ui.Drawer, side: end }, afterSubmit: again }
  layout: { kind: Ui.BoardLayout, groups: { property: status } }
```

A board's `move` names an action you declare over a route of your own; crud
serves none. Import `ui` too to name a layout or surface.

**When to hand-build instead.** `CrudUi.Admin` has no key for chosen columns
beyond a layout's, a row style, a page size, fewer filters, a filter's
`pinned` / `control` / `default` / `values`, presets, chosen form fields or row
actions. For those, replace it with what it expands into and edit that: a
`Ui.CollectionPresentation` (with the `relations`), two `Ui.Form`s over the
`create` and `update` shapes, a `Ui.Listing` over the `list` shape with
`create` / `edit` openers and `delete: true`, and a `Ui.Filters` with the
listing as its `content`. Nothing else moves.

A screen that is not one table's records — a dashboard, a report, an
operation — is hand-built from the kinds above over routes of your own.

## Themes, styling and custom components

- **Theme and brand are two keys.** `theme:` is one `UiReact.Theme` — the look
  and, optionally, control sets: `!ref UiReact.defaultTheme`, another module's
  exported theme (find one with `search_resources`), or `{ kind: UiReact.Theme,
  stylesheets: [!module-path ./look.css] }`. `tokens:` is the brand over it: a
  `Ui.DesignTokens` of a closed token set (`color.*`, `radius.*`, `space.*`,
  `shadow.*`, `font.*`, `font-size.*`, `line-height.*`, `width.page`,
  `space.page`), each a CSS value string, or a list of `{ tokens, when? }`.
- **Control sets.** A theme's `controls` lists `UiReact.Controls` sets, each
  declared in the library shipping its browser entry; no two entries implement
  one control. The fifteen inline controls may be replaced in any subset; the
  nine layer controls (`Select`, `MultiSelect`, `Dialog`, `Drawer`, `Popover`,
  `Confirmation`, `Menu`, `Tooltip`, `Navigation`) only as one unit, or the app
  is refused before it runs. `ui-react-radix` exports `theme`, drawn with Radix.
- **Stylesheets.** Everything drawn carries `data-telo-part`, a stable
  contract; your `stylesheets` are unlayered and win over the renderer's
  layers. Page width and inset are tokens, not CSS.
- **Custom components.** A library ships a browser entry built for the
  renderer's ABI and publishes it with `Ui.ComponentExport` (`entry`,
  `export`, `props` as a shape), exported as an instance. An application
  places it with `Ui.Component` (`component: !ref <Alias>.<export>`, `props`,
  `model` when a prop reads `row`), on a page or as a table column `cell`;
  props are checked against the export's shape. The entry declares
  `abi: ui_react-1`: a named export that is a React function component. It may
  leave only `react`, `react/jsx-runtime`, `react-dom` and `@telorun/ui-react`
  as `external`; another ABI or external becomes an `error` node at start.
  `useHost()` from `@telorun/ui-react` gives `location`, `navigate`, `href`,
  `fetch` (same-origin credentials), `notifyChanged(basePath)` (listings over
  it re-fetch) and `onChanged(basePath, listener)`.
- **Your own layout.** A component written for the layout ABI
  (`ui_react_layouts-1`: it receives records, groups, period and tree children
  and reports intents) is drawn by `Ui.ComponentLayout`, for a map, a seat
  plan or any drawing the built-in layouts lack.
- **Reusable sections.** `Ui.View` holds one node tree (`content`), placed
  wherever needed; a library exports one for its own interface.

## Manifests wire no events

There is no `onClick` and no handler list: a listing's buttons, a form's submit
and a filter's change are built in; an operation is a `Ui.Action`. Requests
carry the page's same-origin credentials; protect the routes with a guard.

## Testing a screen

Start the application with `App.Instance` (module `app`) in a
`Run.Sequence`'s `with:` and request its documents with an HTTP client:

- `<mount>/_telo/ui/app` is the application document (title, pages,
  navigation, stylesheets); `<mount>/_telo/ui/page?path=<page path>` is one page's
  document, its `children` the resolved nodes — `listing`, `form`, `action`,
  `filters`, `component`, or `error` with a `code` where a node could not be
  produced.
- Assert what the page offers: the node types, a listing's layout, an
  action's `path` and `fields`, a listing's `rowActions`.
- Call the routes the screen uses with the records the page would send — a
  list query, a create, the action's input — and assert the answers,
  including the 400 problem for a refused record.

```yaml
kind: Run.Sequence
metadata: { name: servesTheTaskScreen }
with:
  - { kind: App.Instance, metadata: { name: app }, source: ../telo.yaml, ports: { http: 19412 } }
targets: [!ref app]
steps:
  - name: page
    invoke: { kind: HttpClient.Request, url: "http://127.0.0.1:19412/admin/_telo/ui/page?path=/" }
  - name: verify
    invoke: { kind: Assert.Equals }
    inputs:
      actual: !cel "steps.page.result.body.children.map(c, c.type)"
      expected: [text, listing]
```

Give each test its own port.

## Before you finish

- `telo check` is clean: an unknown column (`CEL_UNKNOWN_FIELD`), a filter the
  collection does not declare (`UI_FILTER_NOT_ACCEPTED`), a layout it cannot serve (`UI_LAYOUT_GROUP_NOT_FILTERABLE`), a key a surface
  does not take (`SCHEMA_VIOLATION`) and a malformed address are all
  reported there.
- Every listing, filter bar and action names a route that exists and answers
  its contract.
- The screen and the API read the same shapes; no shape is restated by hand
  except an `Http.Api` route's inline request body.
