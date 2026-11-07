---
status: done
priority: medium
depends-on: []
packages: [modules/data-model, modules/crud, modules/crud-ui, modules/ui, modules/ui-react, modules/ui-react-radix, examples/ui-showcase, examples/todo-app]
---

# Search box with filter tokens

## Goal

A filter bar can be drawn as one search box. The viewer types, and the box offers what the text could mean: search everywhere, or one filter per field that accepts text ("Title contains back"). Picking one turns it into a chip. Field names can be typed too (`status:draft,review`, `publishedOn>=2026-11-01`), and a field picked from the list opens its value picker: an enum's values or a relation's records, labelled by name.

Every chip is a filter the collection already declares, joined to the others by AND. The one OR is a search across several properties, which the collection declares itself. The viewer writes no OR, parentheses or negation, so `telo check` still judges every request a screen can send.

## Example

`examples/ui-showcase` gains this posts screen, with a test under its own `tests/`. Page `/` draws the bar as a search box. Page `/table` draws the same filters beside the table, with the display options now on the placement (section 4). Page `/releases` opens with a search already typed.

```yaml
kind: Telo.Application
metadata: { name: BlogAdmin }
lang: en
imports:
  Http: ../../modules/http-server
  SQLite: ../../modules/sqlite
  Crud: ../../modules/crud
  CrudUi: ../../modules/crud-ui
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
targets: [!ref migrate, !ref server]
ports: { http: { env: PORT, protocol: tcp, default: 8078 } }
variables:
  dbFile: { env: DB_FILE, type: string, x-telo-type: { name: Telo.HostPath, entry: file }, default: blog.db }
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
---
kind: SQLite.Table
metadata: { name: authorsTable }
table: authors
columns:
  id: { type: integer, primaryKey: true }
  name: { type: text, nullable: false }
  email: { type: text, nullable: false, unique: true }
seeds:
  key: [id]
  rows:
    - { id: 1, name: Sofia Rossi, email: sofia@northwind.example }
    - { id: 2, name: Maya Harris, email: maya@northwind.example }
---
kind: SQLite.Table
metadata: { name: postsTable }
table: posts
columns:
  id: { type: integer, primaryKey: true, identity: always }
  seed_key: { type: text, unique: true }
  title: { type: text, nullable: false }
  body: { type: text, nullable: false, default: "" }
  author_id: { type: integer }
  status: { type: text, nullable: false, default: draft }
  published_on: { type: text }
foreignKeys:
  posts_author: { columns: [author_id], references: { table: !ref authorsTable, columns: [id] }, onDelete: set null }
seeds:
  key: [seed_key]
  rows:
    - { seed_key: P01, title: How we plan a sprint, body: We start from the backlog., author_id: 1, status: published, published_on: "2026-10-05" }
    - { seed_key: P02, title: Backups that restore, body: Test the restore first., author_id: 2, status: review, published_on: "2026-11-02" }
    - { seed_key: P03, title: Writing release notes, body: Lead with what changed and go back to it last., author_id: 1, status: draft }
---
kind: SQLite.Schema
metadata: { name: migrate }
connection: !ref db
tables: [!ref authorsTable, !ref postsTable]
---
kind: Telo.JsonSchema
metadata: { name: AuthorDraft }
schema:
  type: object
  additionalProperties: false
  required: [name, email]
  properties:
    name: { type: string, title: Name, minLength: 1 }
    email: { type: string, title: E-mail, minLength: 3 }
---
kind: Telo.JsonSchema
metadata: { name: Author }
extends: AuthorDraft
schema: { type: object, required: [id], properties: { id: { type: integer } } }
---
kind: Crud.Collection
metadata: { name: authors }
model: !ref Author
table: !ref authorsTable
schemas: { list: !ref Author, create: !ref AuthorDraft, update: !ref AuthorDraft }
query:
  filters: [{ property: id, operator: in }, { property: name, operator: contains }]
  sort: [{ property: name }]
---
kind: CrudUi.CollectionSource
metadata: { name: authorsSource }
collection: !ref authors
basePath: /api/authors
---
kind: Telo.JsonSchema
metadata: { name: PostDraft }
schema:
  type: object
  additionalProperties: false
  required: [title, body, status]
  properties:
    title: { type: string, title: Title, minLength: 1 }
    body: { type: string, title: Body }
    authorId: { type: integer, title: Author }
    status:
      type: string
      title: Status
      enum: [draft, review, published]
      oneOf:
        - { const: draft, title: Draft }
        - { const: review, title: In review }
        - { const: published, title: Published }
      default: draft
    publishedOn: { type: string, title: Published on, format: date }
---
kind: Telo.JsonSchema
metadata: { name: Post }
extends: PostDraft
schema: { type: object, required: [id], properties: { id: { type: integer } } }
---
# One text matches a post when its title or its body contains it.
kind: Crud.Collection
metadata: { name: posts }
model: !ref Post
table: !ref postsTable
schemas: { list: !ref Post, create: !ref PostDraft, update: !ref PostDraft }
query:
  search: { properties: [title, body] }
  filters:
    - { property: title, operator: contains }
    - { property: authorId, operator: eq }
    - { property: status, operator: in }
    - { property: publishedOn, operator: gte }
    - { property: publishedOn, operator: lte }
  sort: [{ property: title }, { property: publishedOn }]
  facets: [{ property: authorId }, { property: status }]
relations:
  authorId: { collection: !ref authors }
---
kind: Ui.CollectionPresentation
metadata: { name: postsPresentation }
source: { kind: CrudUi.CollectionSource, collection: !ref posts, basePath: /api/posts }
relations:
  authorId:
    source: !ref authorsSource
    label: !cel "row.name"
    hint: !cel "row.email"
    search: { property: name, operator: contains }
---
kind: UiReact.App
metadata: { name: ui }
title: Blog
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Posts
    children:
      - type: composite
        ref:
          kind: Ui.Filters
          presentation: !ref postsPresentation
          search: {}
          policy:
            placement: { kind: Ui.SearchBoxPlacement, placeholder: "Search posts, or filter by author, status or date" }
            state: { key: posts, address: true }
          fields: &postFilters
            - { property: title, operator: contains }
            - { property: authorId, operator: eq, values: present }
            - { property: status, operator: in }
            - { property: publishedOn, operator: gte }
            - { property: publishedOn, operator: lte }
          presets:
            - { label: Everything, values: [] }
            - { label: Drafts about releases, search: release, values: [{ property: status, operator: in, value: [draft] }] }
          content: &postTable
            type: composite
            ref:
              kind: Ui.Listing
              presentation: !ref postsPresentation
              model: !ref Post
              layout:
                kind: Ui.TableLayout
                columns:
                  - value: !cel "row.title"
                  - value: !cel "row.authorId"
                  - value: !cel "row.status"
                  - value: !cel "row.publishedOn"
  - kind: Ui.Page
    path: /table
    title: Posts beside their filters
    children:
      - type: composite
        ref:
          kind: Ui.Filters
          presentation: !ref postsPresentation
          search: { pinned: true }
          policy:
            # The folded bar on a narrow screen keeps `show` and `controls` from here.
            placement: { kind: Ui.AsidePlacement, show: chosen, controls: chips, compact: { kind: Ui.CollapsiblePlacement } }
            state: { key: posts, address: true }
          fields: *postFilters
          content: *postTable
  - kind: Ui.Page
    path: /releases
    title: Release posts
    children:
      - type: composite
        ref:
          kind: Ui.Filters
          presentation: !ref postsPresentation
          # Opens searching for "release"; changes wait for the Apply button.
          search: { default: release }
          policy:
            placement: { kind: Ui.SearchBoxPlacement }
            apply: button
          fields: [{ property: status, operator: in }]
          content: *postTable
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /api/posts
    mount: { kind: Crud.Api, connection: !ref db, plural: posts, singular: post, collection: !ref posts }
  - path: /api/authors
    mount: { kind: Crud.Api, connection: !ref db, plural: authors, singular: author, collection: !ref authors }
  - { path: /, mount: !ref ui }
```

Both pages keep their state under the key `posts` in the address, so a filtered link opens filtered on either page:

```
/?_telo.f.posts.search=back&_telo.f.posts.status.in=draft&_telo.f.posts.status.in=review
```

## 1. `data-model`: declared search

`DataModel.Collection` gains `query.search`: `{ properties }`, a list of at least one string property. One text then matches a record when any of them contains it, ignoring case.

- Wire: `search=<text>`, AND-ed with the other filters. A facet request takes it like any other filter.
- `search` joins the reserved query names: `limit`, `cursor`, `sort`, `facet`, `search`, and anything starting with `_telo`. A filter on a property called `search` is now `DATA_MODEL_FILTER_RESERVED_NAME`.
- Without `query.search`, a request carrying `search` is refused as an undeclared filter is.

**Rules**, each a resource rule with an `ERR_` twin:

| Code | When |
| --- | --- |
| `DATA_MODEL_SEARCH_UNKNOWN_PROPERTY` | a search property is not declared by `model` |
| `DATA_MODEL_SEARCH_UNSUPPORTED` | a search property is not a string (`null` aside) |

An empty `properties` list is a `SCHEMA_VIOLATION` (`minItems: 1`).

The example with `properties: [title, summary]`, then `[title, authorId]`, then `[]`, then a filter on a property named `search`:

```
$ telo check ./telo.yaml
telo.yaml:122:13  error  Crud.Collection/posts: search property 'summary' is not declared by the model (declared: title, body, authorId, status, publishedOn, id)  DATA_MODEL_SEARCH_UNKNOWN_PROPERTY
$ telo check ./telo.yaml
telo.yaml:122:20  error  Crud.Collection/posts: search property 'authorId' is an integer; a search reads string properties only  DATA_MODEL_SEARCH_UNSUPPORTED
$ telo check ./telo.yaml
telo.yaml:122:13  error  Crud.Collection/posts: 'query.search.properties' must have at least 1 item  SCHEMA_VIOLATION
$ telo check ./telo.yaml
telo.yaml:124:7  error  Crud.Collection/posts: 'search' is a reserved query name and cannot be filtered  DATA_MODEL_FILTER_RESERVED_NAME
```

**Docs:** `modules/data-model/docs/collection.md` and `collection-contract.md` (the key, `search=`, the reserved name).

**Verify:**
- Both rules and the empty list are pinned both ways in `modules/data-model/tests/`.
- No in-repo collection filters a property called `search`.

## 2. `crud`: answering a search

`Crud.Api` answers `search=<text>` with the match it uses for `contains`, on each declared property's column, OR-ed together and AND-ed with the other filters. A facet request answers under the search too. On a collection that declares no search, `search` is refused like any undeclared parameter.

```
GET /api/posts?search=back&status.in=draft&status.in=review
```

```json
{
  "rows": [
    { "id": 2, "title": "Backups that restore", "body": "Test the restore first.", "authorId": 2, "status": "review", "publishedOn": "2026-11-02" },
    { "id": 3, "title": "Writing release notes", "body": "Lead with what changed and go back to it last.", "authorId": 1, "status": "draft" }
  ],
  "total": 2,
  "next": null
}
```

```
GET /api/posts?facet=authorId&search=back
```

```json
{ "values": [ { "value": 1, "count": 2 }, { "value": 2, "count": 1 } ], "next": null }
```

```
GET /api/authors?search=sofia
```

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "The list request is not valid.",
  "code": "ERR_CRUD_QUERY_INVALID",
  "data": { "issues": [ { "pointer": "/query/search", "keyword": "additionalProperties", "params": { "additionalProperty": "search" } } ] }
}
```

**Docs:** `list-route.md` (the parameter, the reserved name, the refusal row).

**Verify:** the three requests above, against the example, answer as shown.

## 3. `ui`: the bar's search

`Ui.Filters` gains `search: { pinned?, default? }`. It holds one string and sends it as `search`. It is not a `fields` entry: `{ operator: search }` in `fields` is a `SCHEMA_VIOLATION`.

- **When a bar has search:** when `search` is written, or when both `fields` and `search` are left out and the collection declares `query.search`. A bar that lists `fields` has chosen its filters and gets a search only by writing `search`. `CrudUi.Admin`'s bar writes neither, so an Admin over a collection declaring `query.search` has a search, with no key of its own for it.
- **Where it is drawn:** first. In the placements that draw controls it is a typed box labelled with the text `searchFilter` ("Search"). Under `Ui.SearchBoxPlacement` it is the box itself (section 5).
- **State:** the bar keeps it under `search`, in the address as `_telo.f.<key>.search`, and `state.fields` may list `search`.
- **Presets:** a preset may carry `search: <text>` beside its `values`. It is active exactly when the bar holds that search and those values.
- **Rule:** `UI_FILTER_SEARCH_UNDECLARED`, a resource rule on `Ui.Filters` twinned by `ERR_UI_FILTER_SEARCH_UNDECLARED`: the bar writes `search` and the collection declares no `query.search`, or a preset carries `search` and the bar has no search.
- **Wire:** the `filters` node gains a `search` member `{ pinned, default }`, `default` `null` when not written, and no member at all when the bar has no search (section 5 shows it).

The example with `query.search` removed from `posts`; then the `/` bar without its `search: {}`, so its preset's `search: release` has nothing to set; then `{ operator: search }` in `fields`:

```
$ telo check ./telo.yaml
telo.yaml:186:11  error  Ui.Filters (pages[0].children[0].ref): the bar searches, but collection 'posts' declares no 'query.search'  UI_FILTER_SEARCH_UNDECLARED
$ telo check ./telo.yaml
telo.yaml:186:11  error  Ui.Filters (pages[0].children[0].ref): preset 'Drafts about releases' sets a search, but the bar has none; write 'search' on the bar  UI_FILTER_SEARCH_UNDECLARED
$ telo check ./telo.yaml
telo.yaml:191:15  error  Ui.Filters (pages[0].children[0].ref): 'fields[0]' must have required property 'property'; 'operator' must be one of eq, contains, in, gt, gte, lt, lte, absent  SCHEMA_VIOLATION
```

**Docs:** `filters.md`: the key, when a bar has it, presets, the rule.

**Verify:**
- A preset holding only `search: back` is active exactly when the bar holds that search.
- A bar with neither `fields` nor `search` over the example's posts draws a search box first, then every filter.
- A `CrudUi.Admin` over the example's posts with `filters: { placement: { kind: Ui.SearchBoxPlacement } }` offers "Search: back" for "back" and sends `search=back`.
- The rule is pinned both ways in `modules/ui/tests/`.

## 4. `ui`: display options move to the placement

`show`, `controls` and `summary` leave `Ui.FilterPolicy` and move to the four placements that draw controls: `Ui.AbovePlacement`, `Ui.AsidePlacement`, `Ui.CollapsiblePlacement` and `Ui.OverlayPlacement`. All four take them from one named shape, `Ui.FilterDisplay`. `Ui.FilterPolicy` keeps `placement`, `apply` and `state`, which mean something under every placement.

- A `compact` placement's omitted members take the values of the placement holding it, filled by `ui`.
- An omitted placement is still `{ kind: Ui.AbovePlacement }`, so a bar that wrote `policy.show` now writes it on the placement.
- `Ui.SearchBoxPlacement` takes none of the three, so writing one there is a `SCHEMA_VIOLATION` from its closed schema.
- Wire: the `above`, `aside`, `collapsible` and `overlay` branches of `Ui.FilterPlacementSpec`, compact ones included, carry the three members filled. The `filters` node loses its own `show`, `controls` and `summary`.
- Both `UI_FILTER_PINNED_UNUSED` rules read `show` from the placement.

Before, in `examples/todo-app`:

```yaml
kind: UiReact.App
metadata: { name: ui }
title: Todos
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Todos
    children:
      - type: composite
        ref:
          kind: CrudUi.Admin
          source: !ref todosSource
          filters:
            show: chosen
            summary: chips
            state: { key: todos, address: true, store: { kind: Ui.LocalStore } }
```

After:

```yaml
kind: UiReact.App
metadata: { name: ui }
title: Todos
theme: !ref UiReact.defaultTheme
pages:
  - kind: Ui.Page
    path: /
    title: Todos
    children:
      - type: composite
        ref:
          kind: CrudUi.Admin
          source: !ref todosSource
          filters:
            placement: { kind: Ui.AbovePlacement, show: chosen, summary: chips }
            state: { key: todos, address: true, store: { kind: Ui.LocalStore } }
```

Writing the old spelling, then `summary` on the search box:

```
$ telo check ./telo.yaml
telo.yaml:142:13  error  CrudUi.Admin (pages[0].children[0].ref): 'filters' must NOT have additional property 'show'  SCHEMA_VIOLATION
$ telo check ./telo.yaml
telo.yaml:189:13  error  Ui.Filters (pages[0].children[0].ref): 'policy.placement' must NOT have additional property 'summary'  SCHEMA_VIOLATION
```

Every in-repo manifest writing `show`, `controls` or `summary` on a policy moves them to its placement in this change.

**Docs:** `filter-placement.md` and `filters.md` (the axes on the placement, compact inheritance); `CrudUi.Admin`'s docs (it still forwards the policy whole).

**Verify:**
- The example's `/table` page, on a narrow viewport, folds into a collapsible bar that shows only the chosen filters as chips.
- No `Ui.FilterPolicy` in the repo carries `show`, `controls` or `summary`.

## 5. `ui`: `Ui.SearchBoxPlacement`

A new filter placement, extending `Ui.FilterPlacement`: the bar's controls sit in one search box above the content. Its one key is `placeholder`, a `Text`, defaulting to the text `searchAndFilter` ("Search and filter"). It does not fold, so it has no `compact` and is not a `Ui.FoldingFilterPlacement`.

**What the box shows**
- The search, when it holds text, is a chip worded by the text `searchChip` ("Search: {$text}").
- Each filter holding a value is a chip worded by the existing `filterChip` ("Status is Draft, In review"). Removing a chip clears that filter.
- A filter with `control: none` is never a chip, as it is never drawn today.

**Suggestions**, a list under the box, in sections:
- **Empty input:** the presets, then the bar's fields by title. Picking a field starts a token for it.
- **Typed text with no field prefix:**
  - the search, worded by `searchChip`, first, when the bar has one;
  - then one entry per field the text can be a value for, in the bar's order, worded by `filterChip`: `contains`, and `eq` / `in` on a string with no `enum` and no relation;
  - then the fields whose title or property name starts with the text.
- **After a field prefix:** that field's values. An enum's values and labels, or a boolean's two. A relation's records, read through the relation's `search` and drawn with its `label` and `hint`. Typed text, for a field taking it. Under `values: present`, only the values that occur, with counts. Under `in`, choices are checkable and several can be picked.

Enter takes the highlighted suggestion; the first one starts highlighted. Arrow keys move the highlight while focus stays in the box. Escape closes the list. Backspace in an empty box removes the last chip, whatever its kind, and clears that filter or the search. To change a filter, the viewer starts it again: its prefix opens the value list with the held values checked.

**Typed tokens.** A token is `<property><operator><value>`. Reading one depends only on the typed text and the fields the bar's node carries, never on a request.
- `:` picks the field's `contains`, else its `in`, else its `eq`; `=` picks `in`, else `eq`; `>`, `>=`, `<` and `<=` pick `gt`, `gte`, `lt` and `lte`.
- The property is the field's property name, matched ignoring case.
- Under `in`, commas separate values. Under every other operator the whole text is one value, commas and spaces included.
- An enum value matches by its value or its label.
- A relation value is never typed: the text after a relation field's prefix is the query for its record suggestions, and a value is committed only by picking a record.

| Bar holds | Typed | Result |
| --- | --- | --- |
| nothing | `status:draft,In review` | one chip, `status` `in` [draft, review] |
| nothing | `publishedOn>=2026-11-01` | one chip, `publishedOn` `gte` 2026-11-01 |
| nothing | `title:a, b` | one chip, `title` `contains` "a, b" |
| nothing | `TITLE:back` | one chip, `title` `contains` "back" |
| nothing | `authorId:sof` | commits nothing; offers Sofia Rossi from the relation's search |
| nothing | `colour:red` | invalid: the bar has no filter on `colour` |
| nothing | `title>b` | invalid: `title` has no `gt` filter |
| nothing | `publishedOn:2026-11-01` | invalid: `publishedOn` has no `contains`, `in` or `eq` filter |
| nothing | `publishedOn=2026-11-01` | invalid: `publishedOn` has no `in` or `eq` filter |
| nothing | `status:archived` | invalid: `archived` is not a status |
| nothing | `publishedOn>=yesterday` | invalid: not a date |
| `publishedOn` `gte` 2026-11-01 | `publishedOn>=2026-11-02` | one chip, `publishedOn` `gte` 2026-11-02 |
| `status` `in` [draft] | `status:review` | one chip, `status` `in` [review] |

An invalid token stays as text, marked with its reason, and sends nothing. Committing a valid token makes it a chip and replaces the value its filter held, under every operator, `in` included; the value then applies as the bar's `apply` says.

**Policy under this placement**
- `pinned` has no effect, since nothing folds: `UI_FILTER_PINNED_UNUSED` (warning) gains a third declaration, a referrer rule on `Ui.SearchBoxPlacement` reporting a pinned field or `search.pinned`. The two existing declarations report `search.pinned` too.
- `apply`, `state`, presets, defaults and Reset behave as in every placement. Under `apply: button`, committed chips wait for the Apply button beside the box.
- The bar's state, its address spelling and its store are unchanged, so a link to a filtered page is the same whichever placement draws the bar.

The example's `/table` bar, which writes `search: { pinned: true }`, with its placement changed to `{ kind: Ui.SearchBoxPlacement }`:

```
$ telo check ./telo.yaml
telo.yaml:211:11  warning  Ui.SearchBoxPlacement (pages[1].children[0].ref.policy.placement): 'search.pinned' has no effect: this placement never folds  UI_FILTER_PINNED_UNUSED
```

**Wire:** `Ui.FilterPlacementSpec` gains the branch `searchBox` `{ placeholder }`. The `search` and `placement` members of each example bar's `filters` node, the members this plan adds or moves:

```json
{
  "/": {
    "search": { "pinned": false, "default": null },
    "placement": { "type": "searchBox", "placeholder": { "text": "Search posts, or filter by author, status or date", "context": null, "lang": "en", "computed": false } }
  },
  "/table": {
    "search": { "pinned": true, "default": null },
    "placement": {
      "type": "aside",
      "side": "start",
      "show": "chosen",
      "controls": "chips",
      "summary": "none",
      "compact": { "type": "collapsible", "open": false, "show": "chosen", "controls": "chips", "summary": "none" }
    }
  },
  "/releases": {
    "search": { "pinned": false, "default": "release" },
    "placement": { "type": "searchBox", "placeholder": { "set": "Ui.Translations", "key": "searchAndFilter" } }
  }
}
```

The same `/` bar with its `search: {}` removed carries no `search` member.

**Texts:** `searchFilter` ("Search"), `searchChip` ("Search: {$text}") and `searchAndFilter` ("Search and filter") join `Ui.Translations`, translated in each of the fourteen shipped `Ui.<language>Translations`.

**Conformance:** new `modules/ui/conformance/filter-tokens.json`, shipped through `files:`, pinning how typed text becomes bar values with no request:
- each operator spelling;
- a comma split under `in`, and a comma kept under `contains` and `eq`;
- an enum matched by its label;
- which filter a bare `:` picks when a property has several;
- a property name typed in another case;
- a relation prefix giving a record query, not a value;
- a commit replacing what its filter held (a row's optional `holding` is the bar's values before the text is read);
- each invalid reason.

**Docs:**
- `filter-placement.md`: the placement, the suggestions, the tokens, the policy.
- `filters.md`: the search and the new rule.

**Verify:**
- On the example's `/`, typing "back" offers "Search: back", then "Title contains back".
- Picking "Search: back" sends `search=back`; picking "Title contains back" sends `title.contains=back`.
- `status:draft,In review` becomes one chip sending `status.in=draft&status.in=review`.
- `publishedOn>=2026-11-01` sends `publishedOn.gte=2026-11-01`.
- `authorId:` offers authors by name, with counts under `values: present` that honour the search.
- Every row of the typed-token table above behaves as shown.
- Backspace in the empty box over the author chip clears `authorId` from the request and from `_telo.f.posts.authorId`; over the search chip it clears `_telo.f.posts.search`.
- `/releases` opens holding the search "release", and a change there sends nothing until Apply.
- `/` and `/table` hold the same state for one address.
- `modules/ui/tests/translations.yaml` reports no missing translation.
- Every rule is pinned both ways in `modules/ui/tests/`; every `filter-tokens.json` row passes in the renderer.

## 6. `ui-react` and `ui-react-radix`: the `Combobox` control

The floating list the built-in selects use cannot draw the box. It moves focus into the list, draws no sections, and a theme set that replaces the layer controls replaces it, so a box built on it would open a second layer stack beside Radix's.

The controls contract gains a tenth layer control, **`Combobox`**, at generation **`ui_react_controls-4`**:
- an input that keeps focus, announcing the highlighted entry through `aria-activedescendant` (the WAI-ARIA combobox pattern);
- a floating list of labelled sections, whose entries are checkable under `in`;
- open, highlight, pick, input change and Backspace on an empty input reported to the renderer as intents.

`-4` is the only generation the renderer hosts. `UI_CONTROLS_LAYERS_PARTIAL` and its twin count `Combobox` among the layer controls, so a set implementing any layer control implements it too.

- **`ui-react`** draws `Ui.SearchBoxPlacement` with it. The chips sit before the input inside `search-box`. The built-in `Combobox` runs on the in-house layer stack. Token reading follows `filter-tokens.json`.
- **`ui-react-radix`** implements `Combobox` on Radix and styles the new parts.
- **Parts:** `search-box`, `search-input`, `search-token`, `search-token-remove`, and the control's own `combobox-content`, `combobox-group` and `combobox-item`.

Before, a third-party layer set:

```yaml
kind: Telo.Library
metadata: { name: AcmeLayers, version: 0.3.0, license: MIT }
imports: { UiReact: ../ui-react }
exports:
  resources: [controls]
  browser:
    - specifier: "@acme/layers"
      path: ./browser/acme-layers.js
      source: ./src/index.ts
      abi: ui_react_controls-3
      external: [react, react/jsx-runtime, react-dom]
      exports: [Select, MultiSelect, Dialog, Drawer, Popover, Confirmation, Menu, Tooltip, Navigation]
---
kind: UiReact.Controls
metadata: { name: controls }
entry: "@acme/layers"
implements: [Select, MultiSelect, Dialog, Drawer, Popover, Confirmation, Menu, Tooltip, Navigation]
```

After:

```yaml
kind: Telo.Library
metadata: { name: AcmeLayers, version: 0.4.0, license: MIT }
imports: { UiReact: ../ui-react }
exports:
  resources: [controls]
  browser:
    - specifier: "@acme/layers"
      path: ./browser/acme-layers.js
      source: ./src/index.ts
      abi: ui_react_controls-4
      external: [react, react/jsx-runtime, react-dom]
      exports: [Select, MultiSelect, Dialog, Drawer, Popover, Confirmation, Menu, Tooltip, Navigation, Combobox]
---
kind: UiReact.Controls
metadata: { name: controls }
entry: "@acme/layers"
implements: [Select, MultiSelect, Dialog, Drawer, Popover, Confirmation, Menu, Tooltip, Navigation, Combobox]
```

The Before against the new `ui-react`, then the After without `Combobox` in `implements`:

```
$ telo check ./telo.yaml
telo.yaml:8:12  error  UiReact.Controls/controls: entry '@acme/layers' is built for ui_react_controls-3; this kind accepts ui_react_controls-4  BROWSER_ENTRY_ABI_UNSUPPORTED
$ telo check ./telo.yaml
telo.yaml:19:13  error  UiReact.Controls/controls: a set implementing layer controls implements all ten; missing: Combobox  UI_CONTROLS_LAYERS_PARTIAL
```

**Docs:** the renderer docs gain the placement, the control and the parts.

**Verify:**
- The renderer's package tests drive arrows, Enter, Escape and Backspace with focus never leaving the input, and run every `filter-tokens.json` row and the `Combobox` vectors and scene.
- Under ui-react-radix, with the box's list open, every live layer root on the page comes from the Radix set.

## 7. Guides, primer, ledger

- **`apps/hub/guides/build-ui.md`** and **`apps/authoring-agent/chat/primer.md`**: `query.search`, the bar's `search`, `Ui.SearchBoxPlacement`, the token spelling, and the display options on the placement.
- **`docs/guides/what-you-get.md`**, under Standard library: "Search and filter in one box". One input that searches the declared properties and turns typed or picked text into filter chips (`status:draft`, a related record by name); the address stays shareable; a search over a property that is not text is refused before the app runs.
- **Root `CLAUDE.md`** and **`modules/CLAUDE.md`**: the filter-policy paragraph (`show`, `controls`, `summary` on the placement, five placements), the controls generation `ui_react_controls-4` and its ten layer controls, and `search` among the reserved query names.

## Releases

One fragment per module, each written with `telo release add`, each body naming only its own module:

| Module | Kind | What the body says |
| --- | --- | --- |
| `data-model` | `Added`, describing the break | `query.search`; `search` is now a reserved query name |
| `crud` | `Added` | answers `search` |
| `crud-ui` | `Added`, describing the break | the `filters` policy takes `show`, `controls` and `summary` on its placement |
| `ui` | `Added`, describing the break | the bar's `search`, `Ui.SearchBoxPlacement`, the token spelling; `show`, `controls` and `summary` move to the placement |
| `ui-react` | `Added`, describing the break | the search box placement; the `Combobox` layer control; controls generation `ui_react_controls-4` |
| `ui-react-radix` | `Added` | `Combobox` on Radix and styles for the search box |

**`requires:` floors:** none. This adds no grammar: `query.search`, the placement and the control are the modules' own vocabulary. A module gets a floor only if running the previous published CLI against it, with the block stripped, rejects it; restoring the block must then give `MODULE_REQUIRES_NEWER_RUNTIME`.
