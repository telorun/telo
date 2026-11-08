# Building a user interface

`ui` is the
vocabulary (pages, listings, forms, actions, filter bars, surfaces, tokens);
`ui-react` is a renderer serving it as data a prebuilt React app interprets,
styled by a swappable theme.

Rules throughout:

- **No frontend code, and no `JS.Script`.** Everything a
  screen does is a declared kind; a component of your own is a library's
  browser entry.
- **Exact schemas and `imports:` lines** of `ui`, `ui-react`, `http-server`,
  `data-model` and, for an admin screen, `crud` and `crud-ui` are on the
  [hub](https://hub.telo.run) (`get_kinds` over MCP).
- **The API comes first.** A screen calls routes, never a database or an
  invocable: declare the routes, then the screen.

## When a screen is the answer

Reach for `ui` when a person browses, filters, creates, edits or deletes
records, or runs an operation. A static page is a
template module; a machine needs the API.

The **application** imports `ui`, `ui-react` and `http-server`, mounts the
renderer on its server and owns the pages. A **library** describing its own
domain's interface imports `ui` alone and exports composites (a listing, a
form, a `Ui.View`) as instances; it never imports a renderer.

## The application

`UiReact.App` is a mount. List it under `Http.Server.mounts` beside the API it
calls, after the API's own mounts:

```yaml
kind: Telo.Application
metadata: { name: Tasks, version: 1.0.0 }
lang: en   # the language of every text below
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
kind: UiReact.App
metadata: { name: admin }
title: Tasks
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Open work
    children:
      - { type: text, text: Open work, style: heading }
      - { type: composite, ref: !ref taskTable }
  - { kind: Ui.Page, path: /about, title: About, children: [{ type: text, text: Tasks tracked by the team. }] }
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
inline (`ref: { kind: Ui.Listing, … }`); `taskTable` is used twice.

- `title` and `theme` (the look: `!ref UiReact.defaultTheme`, or another) are
  required. `pages` (at least one) are `Ui.Page`s — `{ path, title, query?,
  width?, children }`, each path unique — inline or `!ref`.
- `navigation: { items, placement? }` is the menu, naming pages by `!ref`, not
  path: `{ type: page, page, text? }`, `{ type: link, text, href }`,
  `{ type: group, text, items }`, each with `when?` and `icon?` (a
  `UiLucide.Icon` from `ui-lucide`, or a `Ui.FileIcon`). Omitted, one entry per
  page; an entry naming an unlisted page is refused by `telo check`.
  `placement` is `Ui.HeaderNavigation` (default), `Ui.SidebarNavigation`
  (`side`, `rail`, `store`), or a compact one (`Ui.OverlayNavigation`,
  `Ui.TabBarNavigation`) that a header's or sidebar's `compact` names.
- Optional: `translations: { catalogs }` of `Telo.TextTranslations` serve texts
  in the negotiated `request.lang` (`Http.Server.preferredLanguages`). The
  renderer's own texts are English; list `ui`'s `Ui.polishTranslations`, …
  (fourteen languages) to translate them, then a `Ui.Translations` (`lang`,
  `messages: { save: Submit }`) to reword. Also `tokens` (the brand),
  `stylesheets` (`!module-path ./ui.css`), `compactBelow`, `pageWidth`
  (`contained` or `full`; a page's `width` wins), `header: { start?, end?,
  width? }`.

### Nodes

A page's `children` are nodes, plain data with a `type`:

| `type` | Fields |
| --- | --- |
| `box`, `stack`, `columns` | `children` |
| `text`, `badge` | `text` |
| `link` | `text`, `href` (an address), `button` (a `Ui.TextButton` / `Ui.IconButton` draws it as a button; `style: accent` emphasises) |
| `menu` | `text`, `items` (`link`s behind a button; `strong` marks the current) |
| `tabs` | `tabs: [{ text, children, when? }]`, `address?` (the chosen tab in the page address) |
| `image` | `src`, `alt` (required, may be empty) |
| `svg` | `markup`, `alt` — drawn as an image, never inserted |
| `value` | `value` (an accessor), `text?`, `href?` — one value, presented as its schema says |
| `list` | `rows` (an accessor), `columns: [{ header?, value, shown? }]`, `heading?` |
| `bar` | `start?`, `center?`, `end?` — node lists; the centre stays centred |
| `command` | `command` (a root's command: `!cel "chat.stop"`), `text`, `button?` |
| `composite` | `ref` — a `!ref`, or an inline declaration |

Every node also takes `style` (not `tabs`; one or a list of `heading`,
`subheading`, `muted`, `strong`, `accent`, `danger`, `warning`, `success`),
`when` (a boolean deciding on the server whether the node is delivered),
`shown` (a condition deciding in the browser whether it is drawn — see "Data
and conditions") and `fill: true` (reach the page's bottom; the innermost
filling node scrolls; not on menu items).

**Texts.** Every label, heading and node text is in the module's `lang:`. A
text over data names its values (`text: { text: { plural: n, cases: { one:
"{$n} task", other: "{$n} tasks" } }, values: { n: !cel "data.open" } }`).

**Addresses.** An address inside the application (a page `path`, a `link`'s
`href`, an `image`'s `src`, a `basePath`, a request target's `path`) is
app-relative: `/` followed by anything but `/` or `\` (`//host` and `/\host`
are refused). A `link` may also start `https://`, `http://` or `mailto:`; an `image`, `https://` or `http://`. It resolves under the mount: at `/admin`,
`/api/reports` is requested at `/admin/api/reports`, so serve the API there.

Links, `href`s, menu items, `navigate` and request targets take a string, or
`{ path, pathParams, queryParams }`: `path` a template whose `{name}`
placeholders are whole segments (`/tasks/{id}`), filled from `pathParams`
(accessors or literals, percent-encoded); `queryParams` the query (null and
empty left out). A link's `path` may be a `!ref` to a `Ui.Page`. An unbound
placeholder or unused `pathParams` entry is refused by `telo check`.

**Per request.** In a page's `children` and `header`, `when` and leaf values
(`text`, `src`, `alt`, `markup`, `style`; not a link's `href`) may be `!cel`
over `request.headers` (lower-case names; test with `in` first) and
`request.ip`. Structure and every `ref` stay literal. A value that is no valid
node becomes an `error` node.

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
---
kind: Telo.JsonSchema
metadata: { name: Task }
extends: NewTask
schema: { type: object, required: [id], properties: { id: { type: integer } } }
```

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
must accept `in` on its key. Relations may be cyclic.

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
(`collection`, `basePath`), one per collection; a `Ui.CollectionPresentation`
shows it for a set of screens (a relation becomes a name in a column, a filter's
choices, a form's picker):
`source`, and `relations: { <property>: { source, label, hint?, href?, search?,
pageSize? } }` — `label`, `hint` and `href` read `row`, the related record. A
presentation holds no keys: a related value is always the target's `key`.

```yaml
kind: Ui.CollectionPresentation
metadata: { name: postsPresentation }
source: { kind: Ui.CollectionSource, collection: !ref posts, basePath: /api/posts }
relations: { authorId: { source: !ref authorsSource, label: !cel "row.name", search: { property: name, operator: contains } } }
```

A `Ui.Listing` draws records: `presentation`, `model` (row shape), `filters`
(fixed equalities), `query`, `pageSize`, `paging` (`pages`, `more`,
`scroll`), `rowStyle`, `create` / `edit`, `delete`, `rowActions`, `empty`,
`layout` (a kind under `Ui.ListingLayout`; default `Ui.TableLayout`, a column
per model property but the key) and `compact`. Also `sort: { by?: { property,
direction }, choosable }` (`choosable: false` fixes the order), `show: { count }` and
`rowActionsDisplay` (`auto` | `inline` | `menu`).

```yaml
kind: Ui.Listing
metadata: { name: postsList }
presentation: !ref postsPresentation
model: !ref Post
paging: more
delete: true
layout: { kind: Ui.BoardLayout, groups: { property: status }, move: { action: !ref setStatus, inputs: { id: !cel "row.id", status: !cel "to.status" } } }
```

- Layouts: `Ui.TableLayout` (`columns`), `Ui.ListLayout`, `Ui.CardLayout`
  (`content`, `size`), `Ui.BoardLayout` (`groups`), `Ui.CalendarLayout` and
  `Ui.TimelineLayout` (`span: { start, end? }`), `Ui.TreeLayout` (`parent`, a
  self-relating property), each with `content`, `move`; only its own keys.
- `groups: { property, values: all | present }` reads one list per value;
  `present` uses the facet request; `span` and `parent` become range and parent
  filters. `telo check` refuses a layout the collection cannot serve (an
  unknown property, a missing `eq`, range or `parent` filter, `present` off
  `facets`). `Ui.ListLayout` takes `frame` (`framed` | `flush`).
- A link to the current page is marked current by itself; write nothing.
- `compact: { kind: Ui.CardLayout, size: small }` is the layout below
  `compactBelow`; boards and trees always load more.
- `move` is a row action over `row` and `to` (the record as the gesture leaves
  it): dragging a card, rescheduling an event or reparenting a tree item runs
  it, never a form replace. Each record also has a "Move to" menu.
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
- `POST <basePath>` creates; `GET`, `PUT` and `DELETE <basePath>/<key>` read,
  replace (the whole record) and delete one record.
- A write body holds only properties with a value; a `null` or wrong JSON type
  is a 400 naming it. A row read is valid against the model.
- Errors are `application/problem+json`; a 400's `data.issues` are `{ pointer,
  keyword, params }`, one at `/body/<property>` marks that field.
- `search=<text>` matches the declared search properties, AND-ed with the filters.
- Query keys `limit`, `cursor`, `sort`, `facet`, `search` and `_telo…` are reserved.

Over one SQL table, `Crud.Api` speaks it (*An admin screen over one table*).

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

- `fields` left out is one control per collection filter. A listed field is a
  `{ property, operator }` pair the collection declares, plus optional
  `pinned`, `control` (`auto`, `select`, `options`, `toggle`, `slider`,
  `tags`, `none`) and `default` (one value, a list under `in`, `true` under
  `absent`, which `auto` draws as a toggle).
- A field over a related property offers the related records, labelled by the
  presentation's relation. `values: all` (default) offers every one; `present`
  only those occurring under the bar's other filters, with counts, and needs
  the property under the collection's `facets`. `options` overrides the source.
- `policy`'s choices combine freely: `apply` (`commit` | `typing` | `button`),
  `placement`, `state`. The display options sit on the placement that draws
  controls: `show` (`all` | `chosen`), `controls` (`direct` | `chips`),
  `summary` (`none` | `chips`); a `compact` placement inherits omitted ones.
- **Placements and stores are kinds**: `Ui.AbovePlacement` (default),
  `Ui.AsidePlacement`, `Ui.CollapsiblePlacement`, `Ui.OverlayPlacement`,
  `Ui.SearchBoxPlacement`; `Ui.LocalStore`, `Ui.SessionStore`. A `state` keeps the bar's values in the
  page address (`address: true`), a store, or both; left out, in memory.
- `pinned` matters only where the bar folds.
- `search: { pinned?, default? }` adds a text search (sent as `search`, kept
  under `search` in the address, first among the controls). Left out, a bar
  without `fields` has it when the collection declares `query.search`; a bar
  with `fields` gets it only by writing it. A preset may carry `search: <text>`.
  `telo check` refuses a search the collection does not declare.
- `Ui.SearchBoxPlacement` (`placeholder?`) draws the bar as one box: filters
  are chips, suggestions offer the search and a filter per field. It takes no
  `show`, `controls`, `summary` or `compact`, and `pinned` has no effect.
  Tokens are typed as `<property><op><value>`: `:` is contains, else in, else
  eq; `=` in or eq; `>`, `>=`, `<`, `<=`. Under `in`, commas split values
  (`status:draft,review`); a relation is picked by name, never typed.

## Forms and where they open — `Ui.Form` and surfaces

A `Ui.Form` names a `model` (write shape) and the `presentation` whose source
it writes to; `fields` left out is one field per enterable property (a
scalar, or a list of scalars). An entry is a property name (control derived
from the model) or a **field kind**: `Ui.InputField` (`control: select | options |
toggle | slider | tags`), `Ui.ChoiceField` / `Ui.PickerField` over an option
source, `Ui.DateRangeField` (`presets`, `initialPreset`). Each judges its own
fit, so `telo check` refuses a control the property cannot take.

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

`value` is a property the collection filters with `in`; `filters` may read the
form's `values`. A relation property is entered with a picker unless you write
the field. `groups` keep fields together; `state` keeps values in the address
or a store.

A listing opens a form through `create` and `edit`, each an object:

```yaml
kind: Ui.Listing
metadata: { name: taskTable }
presentation: !ref tasksPresentation
model: !ref Task
create:
  form: { kind: Ui.Form, model: !ref NewTask, presentation: !ref tasksPresentation }
  surface: { kind: Ui.Drawer, side: end, compact: { kind: Ui.Dialog, size: full } }
  afterSubmit: again
edit: { form: { kind: Ui.Form, model: !ref NewTask, presentation: !ref tasksPresentation }, surface: { kind: Ui.Panel, address: { name: task } }, unsaved: confirm }
delete: true
```

- `surface` is a **kind**: `Ui.Dialog`, `Ui.Drawer`, `Ui.Popover` (the
  overlays), `Ui.InlineSurface`, `Ui.Panel` or `Ui.PageSurface`; an
  inapplicable key is a `SCHEMA_VIOLATION`. `address: { name }` puts the open
  form in the page address; give a listing's `create` and `edit` the **same**
  name, so one query key (`_telo.open.<name>`) holds whichever form is open
  (empty for create, the row's key for edit). `compact` is the overlay used
  below `compactBelow`.
- `afterSubmit` is `close`, `keep`, and on `create` also `again`; `unsaved`
  is `confirm` or `discard`.
- **`ui` owns every default.** Leave a key out; never restate a default.

## Actions — a button that runs an operation

`Ui.Action` is a form with one button, sending a request to a route, and node
trees drawn from what the route answered. It is reached by URL only:
`request: { method, target }`, `method` `POST` (default), `PUT`, `PATCH` or
`DELETE` — no `!ref` to a handler.

Give the route and the action the **same two shapes**:

```yaml
kind: Telo.JsonSchema
metadata: { name: ReportRequest }
schema:
  { type: object, required: [month], properties: { month: { type: string, title: Month, pattern: "^[0-9]{4}-[0-9]{2}$" } } }
---
kind: Telo.JsonSchema
metadata: { name: ReportAnswer }
schema:
  { type: object, required: [files], properties: { files: { type: array, items: { type: object, properties: { name: { type: string, title: File }, url: { type: string } } } } } }
---
kind: Ui.Action
metadata: { name: generate }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
request: { target: /api/reports }
label: Generate
result: { type: list, heading: Files, rows: !cel "result.files", columns: [{ value: !cel "row.name" }, { value: !cel "row.url" }] }
onSuccess: { refreshes: [/api/reports] }
```

The route answers the **action contract**: a 2xx with a JSON object valid
against `outputModel` (read only when `result` or `navigate` does), and a
problem for any failure. An `Http.Api` route's `request.schema.body` takes the
JSON Schema inline (a `!ref` there passes `telo check` and fails at boot), so
write the shape out and keep it equal to `inputModel`.

- No `inputModel` properties: a bare button. `fields` left out is every
  enterable input property; every required input must be enterable.
- `result:` is a node tree drawn from a success, over `result` (typed from
  `outputModel`; with none, `result.<member>` is `CEL_UNKNOWN_FIELD`), `input`
  (the record sent) and `values` (what the form holds now). `failure:` is drawn
  for anything else (a 400 also marks the fields) over `error` (`status`,
  absent with no answer; `code`; `message`), `input` and `values`; left out, it
  shows the error's code and message. Use a `list` node in `result`, not `lists`.
- `target` is an address over `input`: `/api/tasks/{id}` with `pathParams:
  { id: !cel "input.id" }`. An input read as exactly `input.<property>` is
  consumed: it travels in the target, not the body. `DELETE` sends no body and
  must consume every input property. A 2xx with no body (204) is a success
  unless `result`, `navigate` or `refreshes` reads `result`.
- `onSuccess.navigate` is an address over `result` and `input`: a declared
  page moves within the app, an `https://` address replaces the page.
  `onSuccess.refreshes` lists request targets; after a 2xx those, the target
  and a listing's `basePath` are announced and every reader of exactly that
  path (`Ui.Data`, `Ui.Listing`, `Ui.Chat`) reads again. A literal segment may
  be `*` (one) or `**` (any, none included): `/api/projects/{id}/**`.
- `concurrency: serial` runs presses in turn (default `parallel`);
  `clearAnswerOn: [<property>]` clears the answer on that input's change.

### Row actions

`rowActions` on a listing or `list` node puts a button on every row:

```yaml
rowActions:
  - { action: { kind: Ui.Action, inputModel: !ref Archive, request: { target: /api/tasks/archive }, label: Archive }, inputs: { id: !cel "row.id", reason: tidy-up }, confirm: Archive this task? }
  - { action: !ref reject, inputs: { id: !cel "row.id" }, prompt: true }
```

- `inputs` is the record sent, checked against that action's `inputModel`: it
  must bind every required input, with matching types. It reads `row` and the
  roots in scope (a listing's `query:`, or the tree a list sits in). The
  action's `request` reads these as `input`.
- `confirm` asks a question first; `prompt: true` opens a dialog (titled with
  `confirm`, else the label) for the action's fields the row does not bind.
  `enabled` (a condition over `row`, with `disabledText`) governs the row's
  button; the action's own does not.
- A pressed row draws its `result` in place of the button and its `failure`
  beside it; the listing's `basePath` is announced and `onSuccess` applies.

## Data and conditions — `Ui.Data`

Data a screen needs when it opens (who is signed in) is a `Ui.Data` reader:
`GET source`, answered by a JSON object valid against `model`, then `content`
drawn over `data`. It is a composite; place it on a page. A sign-in gate is a reader plus conditions, not a kind:

```yaml
- type: composite
  ref:
    kind: Ui.Data
    model: !ref Auth
    query:
      signin: { type: string, enum: [denied, expired] }
    source: { path: /api/auth, queryParams: { reason: !cel "query.signin" } }
    reloadOn: [focus, unauthorized]
    content:
      type: stack
      children:
        - { type: value, value: !cel "data.email", shown: { at: !cel "data.authorized", matches: { const: true } } }
        - { type: text, text: Sign in to continue., shown: { at: !cel "data.authorized", matches: { const: false } } }
```

- `loading` / `failure` are node trees; left out, `ui` fills them.
- `reloadOn: [focus]` reads again on window focus, `[unauthorized]` when a
  request inside `content` answers 401.
- A condition is `{ at, matches }`: `at` a plain chain over the roots in
  scope, `matches` a schema in a closed profile (`type`, `const`, `enum`,
  `not`, `allOf`, `anyOf`, `required`, `properties`, `items`, `minItems`,
  `maxItems`, `uniqueItems`, `minLength`, `maxLength`, `pattern`, numeric
  bounds). A missing value never matches, even under `not`; test absence on the
  parent: `{ at: !cel "data", matches: { not: { required: [email] } } }`.
- Roots: `data` (a reader's `content`), `error` (its `failure`), `query`,
  `values` (a form's or action's fields), `row` (a `list` column). Only a
  condition, a `value` / `list` / `command` node or an address's params read
  one.
- A field's `shown` reads `values`: a hidden field is not sent, but a required
  property still blocks submitting. An action's `enabled: { at, matches,
  disabledText }` disables its button until it holds.
- A `list` draws one answer's rows, unpaged; a growing set is a `Ui.Listing`.

## A chat — `Ui.Chat`, beside a list of conversations

One composite, no conversation list. A `Ui.ConversationSource` pairs a
`Conversation.Conversation` (`ai-chat`'s) with its `basePath`; `Ui.Chat` names
it plus `placeholder`, `starters` (a text, or `{ prompt, onChoose: send | fill }`),
`show: { reasoning, toolDetail, usage, copy }`, `composer: { actions: inside | outside }`,
`buttons` (`copy`, `edit`, `regenerate`, `attach`, `send`, `stop`:
`Ui.TextButton`/`Ui.IconButton { icon?, label }`; first three icons) and
`header` (nodes over `conversation`, the open summary or null, and `chat`'s
commands `exportTranscript`, `copyTranscript`, `stop`, `newConversation`;
default a `bar` holding export, `[]` none).

- `conversation: { parameter: conversation }` follows that query parameter
  (absent: a new conversation; a created one is written back; a link or back
  switches without cancelling a turn); omitted, the choice is in memory.
  `refreshes: [/api/chat/conversations]` re-reads that path when a send is
  admitted and a turn ends.
- Upload shows only when the endpoint offers attachments. Mount
  `{ kind: Chat.Api, conversation: !ref … }` at the same `basePath`; import
  `ai-chat` as `Chat`, never `AiChat`. `Conversation.Spec.operations` is
  `branch` and `cancel` at most.
- Compose the list: a `Ui.SplitView`, `aside.actions` a button `link` to the
  page (New conversation), `aside.content` a `Ui.Listing` over a
  `Ui.CollectionSource` for `Conversation.conversations` (`basePath:
  /api/chat/conversations`, `model: !ref Conversation.ConversationSummary`),
  `delete: true`, rows linking with `queryParams: { conversation: !cel
  "row.id" }`, rename / archive as `PATCH` row actions; the chat is `content`
  with `fill: true`.

### Ui.SplitView

A composite placing `aside` (`{ actions?, content }`) by `content`: `side`
(`start` | `end`), `size` (`small` | `medium` | `large`), `label` (required),
`collapse: { collapsed?, state: { key, store } }`, `compact` (default a
`Ui.Drawer` below `compactBelow`), `frame` (`flush` | `framed`) and `toggle`
(`Ui.IconButton` | `Ui.TextButton`). The aside stays mounted, with no request
while hidden. Trees hold no root: put `value` / `list` in a composite that
declares one.

## An admin screen over one table — `crud` and `crud-ui`

For a listing over one SQL table, two modules give both halves from one
declaration. `crud` imports no `ui`; `crud-ui` imports
`crud` and `ui`.

- `Crud.Collection` is a `DataModel.Collection` (with `relations` and
  `query.facets`) over a `table`, an `Sql.Table` whose primary key is `id`,
  holding `model` and `schemas: { list, create, update }`, all required: `model`
  and `list` declare a required `id`; `create` and `update` leave it out. A
  relation contradicting the table's foreign key is refused before the app runs.
- `Crud.Api` mounts list / read / create / replace / delete over `collection:`
  (the whole collection contract). Declare the table in your SQL backend.
- `CrudUi.CollectionSource` is a `Ui.CollectionSource` over a `Crud.Collection`
  (`collection`, `basePath`).
- `CrudUi.Admin` is the whole screen (filter bar, sortable paged listing,
  create and edit forms, confirmed delete) from `source` and, optionally,
  `relations`, `filters` (the bar's `policy`), `create` and `edit` (`{ surface?,
  afterSubmit?, unsaved? }`), `paging`, `layout` and `compact`; a key left out
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
kind: Crud.Api            # mounted on the server at the path basePath is under
metadata: { name: tasksApi }
connection: !ref db
singular: task
plural: tasks
collection: !ref tasks
```

Placed as a page child (`type: composite`):

```yaml
ref:
  kind: CrudUi.Admin
  source: !ref tasksSource
  filters: { placement: { kind: Ui.AbovePlacement, show: chosen, summary: chips }, state: { key: tasks, address: true } }
  create: { surface: { kind: Ui.Drawer, side: end }, afterSubmit: again }
  layout: { kind: Ui.BoardLayout, groups: { property: status } }
```

A board's `move` names an action over a route of your own; crud serves none.
Import `ui` too to name a layout or surface.

**When to hand-build instead.** `CrudUi.Admin` has no key for chosen columns,
a row style, a page size, fewer filters, a filter's `pinned` / `control` /
`default` / `values`, presets, chosen form fields or row actions. Replace it
with what it expands into: a `Ui.CollectionPresentation`, two `Ui.Form`s over
the `create` and `update` shapes, a `Ui.Listing` over the `list` shape and a
`Ui.Filters` holding it.

## Themes, styling and custom components

- **Theme and brand are two keys.** `theme:` is one `UiReact.Theme` (the look,
  optionally control sets): `!ref UiReact.defaultTheme`, another module's
  theme (search the hub), or `{ kind: UiReact.Theme, stylesheets:
  [!module-path ./look.css] }`. `tokens:` is the brand over it: a
  `Ui.DesignTokens` of a closed set (`color.*`, `radius.*`, `space.*`,
  `shadow.*`, `font.*`, `font-size.*`, `line-height.*`, `width.page`,
  `space.page`), each a CSS value string, or a list of `{ tokens, when? }`.
- **Control sets.** A theme's `controls` lists `UiReact.Controls` sets, each
  declared by the library shipping its browser entry; no two implement one
  control. The fifteen inline controls may be replaced in any subset, the ten
  layer controls (`Select`, `MultiSelect`, `Combobox`, `Dialog`, `Drawer`,
  `Popover`, `Confirmation`, `Menu`, `Tooltip`, `Navigation`) only as one unit. `ui-react-radix` exports `theme`.
- **Stylesheets.** Everything drawn carries `data-telo-part`; your unlayered
  `stylesheets` win. Width and inset are tokens.
- **Custom components.** A library ships a browser entry (`abi: ui_react-1`: a
  named export that is a React function component) and publishes it as an
  instance of `Ui.ComponentExport` (`entry`, `export`, `props` as a shape). An
  application places it with `Ui.Component` (`component: !ref <Alias>.<export>`,
  `props`, `model` when a prop reads `row`), on a page or as a table column
  `cell`; props are checked against the shape. The entry may leave only
  `react`, `react/jsx-runtime`, `react-dom` and `@telorun/ui-react`
  `external`; anything else is an `error` node at start.
  `useHost()` from `@telorun/ui-react` gives `location`, `navigate`, `href`,
  `fetch` (same-origin credentials), `notifyChanged(path)` (readers of that
  path re-fetch) and `onChanged(path, listener)`.
- **Your own layout.** A component for the layout ABI (`ui_react_layouts-1`)
  is drawn by `Ui.ComponentLayout` (`component`, `props`, the `groups` / `span`
  / `parent` plan): the renderer fetches, the component draws — a map, a seat plan.
- **Reusable sections.** `Ui.View` holds one node tree (`content`); a library
  exports one.

## Manifests wire no events

There is no `onClick`: listing buttons, form submit and filter change are
built in; an operation is a `Ui.Action`. Requests carry the page's same-origin
credentials; guard the routes.

## Testing a screen

Start the app with `App.Instance` (module `app`) in a `Telo.Sequence`'s `with:`
and request its documents:

- `<mount>/_telo/ui/app` is the application document (title, pages,
  navigation, stylesheets); `<mount>/_telo/ui/page?path=<page path>` is one page's
  document, its `children` the resolved nodes — `listing`, `form`, `action`,
  `filters`, `component`, or `error` with a `code` where a node could not be
  produced.
- Assert node types, a listing's layout and `rowActions`, an action's
  `request`/`fields`; call the routes with the records the page would send, a
  refused 400 too. Give each test its own port.

## Before you finish

- `telo check` is clean: it reports an unknown column (`CEL_UNKNOWN_FIELD`), a
  filter the collection does not declare (`UI_FILTER_NOT_ACCEPTED`), a layout
  it cannot serve (`UI_LAYOUT_GROUP_NOT_FILTERABLE`), a key a surface does not
  take (`SCHEMA_VIOLATION`), a malformed address and a path template
  (`PATH_PARAMETER_UNBOUND`, `PATH_PARAMETER_UNUSED`).
- Every listing, filter bar and action names a route answering its contract;
  the screen and the API read the same shapes.
