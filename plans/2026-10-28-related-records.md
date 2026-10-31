# Related records and collection layouts across data-model, ui, crud and crud-ui

## Goal

An author declares that one collection's property points at another collection's records (`posts.authorId` → authors). From that one declaration:

- a listing shows the related record's label instead of its raw key, in any layout;
- a filter bar lets the viewer pick the related record from a list, optionally only those that occur in the filtered list, with counts;
- a create/edit form offers a picker of related records;
- with crud over SQL, a relation that contradicts the table's foreign key is refused before the app runs and again at start.

One collection can be drawn any way regular apps draw one: as a table, a list, cards, a board, a calendar, a timeline or a tree, with a different layout on narrow screens. Openers, row actions, paging, labels and filters are declared once, whatever the layout. Another module can add a layout without changing `ui`.

The collection contract — what a list endpoint accepts — stops being a UI concept. It moves into a new neutral module that both the API side and the screen side import, and crud's screen generator moves out of crud.

## Module layout

| Module | Alias | Imports | Holds |
| --- | --- | --- | --- |
| `data-model` (new) | `DataModel` | nothing | `DataModel.Collection` and the collection contract |
| `ui` | `UiKit` in consumers | `data-model` | screens; how a collection is reached and shown (`Ui.CollectionSource`, `Ui.CollectionPresentation`, `Ui.CollectionOptions`); `Ui.Listing` and the listing layouts |
| `ui-react`, `ui-react-radix` | — | unchanged | the listing renderer, the built-in layouts, the `ui_react_layouts-1` contract, their styles |
| `crud` | `Crud` | `http-server`, `sql`, `data-model` | `Crud.Collection` (today's `Crud.Model`), `Crud.Api` (today's `Crud.Resource`); no `ui` import |
| `crud-ui` (new) | `CrudUi` | `crud`, `ui` | `CrudUi.Admin` (today's `Crud.Ui`), `CrudUi.CollectionSource` |

Before: `Crud.Model` extends `Ui.Collection`, and `crud` imports `ui` to describe its own API. After: no kind in `crud` names a `UiKit.*` kind. `ui` names no renderer ABI and no layout from another module.

## 1. `data-model`: `DataModel.Collection`

A concrete `Telo.Provider` with its own controller, publishing what it declares. It describes one list endpoint, whatever serves it:

| Key | | |
| --- | --- | --- |
| `model` | required | the shape of one record as it is read; `x-telo-ref: { kind: Telo.Type, use: schema }` |
| `key` | `id` | the property identifying a record |
| `query.filters` | required | `{ property, operator }` each, as today |
| `query.sort` | required | `{ property }` each, as today |
| `query.facets` | none | `{ property }` each: properties whose present values, with counts, the endpoint answers |
| `relations` | none | `<property>: { collection }`, where `collection` names another `DataModel.Collection`, `x-telo-ref: { kind: Self.Collection, use: schema }` |

A relation's property holds the target's `key` (a list property holds a list of them). The entry never restates which property of the target it matches. Because the reference is `use: schema`, a collection that relates to itself (`employees.managerId`) or two that relate to each other create no init-order edge.

**Operators:** `eq`, `contains`, `gt`, `gte`, `lt`, `lte`, `in`, and the new `absent`. `absent` is sent as `<property>.absent=true|false` and matches records whose property is null or missing (or present, with `false`). It fits a property the model leaves optional or admits `null`; on any other property it is `DATA_MODEL_FILTER_OPERATOR_UNSUPPORTED`.

**The wire contract** gains the facet request. `GET <basePath>?facet=<property>` plus any filters answers `{ values: [{ value, count }], next }`, paged by `limit` / `cursor` like a list. `facet` joins the reserved query names: `limit`, `cursor`, `sort`, `facet`, and anything starting with `_telo`.

**Rules**, each a resource rule with an `ERR_` twin at creation:

| Code | When |
| --- | --- |
| `DATA_MODEL_KEY_UNDECLARED` | `model` does not declare `key`, or does not list it as required |
| `DATA_MODEL_FILTER_UNKNOWN_PROPERTY` | a filter names a property `model` does not declare |
| `DATA_MODEL_FILTER_OPERATOR_UNSUPPORTED` | the operator does not fit the property's type |
| `DATA_MODEL_FILTER_RESERVED_NAME` | a filter property is a reserved query name |
| `DATA_MODEL_SORT_UNKNOWN_PROPERTY` | a sort names a property `model` does not declare |
| `DATA_MODEL_SORT_UNSUPPORTED` | the sorted property does not hold one plain value |
| `DATA_MODEL_FACET_UNKNOWN_PROPERTY` | a facet names a property `model` does not declare |
| `DATA_MODEL_FACET_UNSUPPORTED` | the faceted property does not hold one plain value |
| `DATA_MODEL_RELATION_UNKNOWN_PROPERTY` | a relation names a property `model` does not declare |
| `DATA_MODEL_RELATION_VALUE_MISMATCH` | the property's type (ignoring `null`, by item type for a list) differs from the type of the target's `key` in the target's `model` |
| `DATA_MODEL_RELATION_KEY_NOT_FILTERABLE` | the target does not accept `{ property: <its key>, operator: in }`, so related records cannot be fetched in one batched request |

The five filter and sort rules are crud's `CRUD_MODEL_FILTER_*` / `CRUD_MODEL_SORT_*` rules, moved and renamed.

**Docs:** `modules/ui/docs/collection.md` and `collection-contract.md` move to `modules/data-model/docs/collection.md` and `modules/data-model/docs/collection-contract.md`. The contract doc gains the facet request and answer, and the `absent` spelling. Also add `README.md`, `LICENSE` and `license: MIT`.

**Verify:**
- A hand-written `DataModel.Collection` presented by a `Ui.Listing`, with a filter on an undeclared property, is refused by `telo check` with `DATA_MODEL_FILTER_UNKNOWN_PROPERTY`. No crud is involved.
- A self-relation and a mutual pair pass `telo check` with no `DEPENDENCY_CYCLE`, and boot.
- A relation whose target has no `in` filter on its key is `DATA_MODEL_RELATION_KEY_NOT_FILTERABLE`.
- `absent` on a required, non-nullable property is `DATA_MODEL_FILTER_OPERATOR_UNSUPPORTED`.
- Every rule is pinned both ways in `modules/data-model/tests/`: refused by `telo check` at the declaring library, and `runFails:` from a consumer that `telo check` does not reach.

## 2. `sql`: typed foreign keys on `Sql.Table`

Before: `foreignKeys` is `type: object` on the `Sql.Table` abstract. Each backend types it itself and the docs don't mention it.

After: the abstract declares the typed entry `{ columns, references: { table, columns }, onDelete?, onUpdate? }`, with `references.table` an `x-telo-ref` to `Self.Table`, `use: schema`. `Postgres.Table` and `SQLite.Table` keep their existing shape, which now matches the abstract. `SQL_FOREIGN_KEY_UNKNOWN_COLUMN` and `SQL_FOREIGN_KEY_ARITY_MISMATCH` stay.

**Docs:** foreign keys documented in the sql and postgres docs, and in a new `modules/sqlite/docs/`.

**Verify:** existing foreign-key tests in sql, postgres and sqlite pass unchanged. A crud rule (§3) can read `foreignKeys` through an `Sql.Table` reference without knowing the backend.

## 3. `crud`

**Names.** One meaning per word across `data-model`, `ui`, `crud` and `crud-ui`: `model` is always a record's shape, and `collection` always a set of records behind one list endpoint. A backend's kind takes the name of the kind it extends, as `Postgres.Table` does `Sql.Table`.

| Today | Becomes |
| --- | --- |
| `Crud.Model` | `Crud.Collection` |
| `Crud.Resource` | `Crud.Api` (an HTTP mount serving the collection's routes and OpenAPI) |
| `Crud.Resource.model` | `Crud.Api.collection`, the key `Ui.CollectionSource` uses for the same reference |
| `CRUD_MODEL_*` (and `ERR_CRUD_MODEL_*`) | `CRUD_COLLECTION_*` (and `ERR_CRUD_COLLECTION_*`) |

`ERR_CRUD_QUERY_INVALID` keeps its name. There is no migration: both kinds' shapes already break.

**`Crud.Collection`** extends `DataModel.Collection` in merge form:
- `schemas.read` is replaced by the inherited `model`, leaving `schemas: { list, create, update }`.
- `key` is narrowed to `const: id`.
- New required `table`: an `Sql.Table` reference, `use: dependency`. camelCase properties map to snake_case columns, as today.

**`Crud.Api`:**
- `collection` is a `Crud.Collection`, `use: dependency`.
- `table` is removed. The table comes from the collection.
- Its schema becomes `additionalProperties: false`, so a leftover `table:` or `model:` is `SCHEMA_VIOLATION`.
- It answers the facet request: a grouped count over the column, under the active filters, paged like a list.
- It answers `absent` with `IS NULL` / `IS NOT NULL`; `ERR_CRUD_QUERY_INVALID` accepts a declared `absent` pair.

**Rules kept, now measured against `model`:** `CRUD_COLLECTION_KEY_UNDECLARED` (for `list` only), `CRUD_COLLECTION_KEY_WRITABLE`, `CRUD_COLLECTION_WRITE_SHAPE_OPEN`, `CRUD_COLLECTION_PROPERTY_NOT_READABLE`, `CRUD_COLLECTION_PROPERTY_TYPE_DIFFERS`, `CRUD_COLLECTION_UPDATE_REQUIRES_OPTIONAL`.

**Rules added**, each with an `ERR_` twin:

| Code | When |
| --- | --- |
| `CRUD_COLLECTION_PROPERTY_UNKNOWN_COLUMN` | a `model` property has no snake_case column on `table` |
| `CRUD_COLLECTION_TABLE_KEY_NOT_PRIMARY` | `id` is not `table`'s primary key |
| `CRUD_COLLECTION_RELATION_FOREIGN_KEY_MISMATCH` | see below |

`CRUD_COLLECTION_RELATION_FOREIGN_KEY_MISMATCH` applies only when two things hold: the relation's target declares a `table`, and this collection's table has a foreign key on the property's snake_case column. That foreign key's `references.table` must then name the target's table, and its `references.columns` must be the snake_case of the target's `key`. A composite key passes when the matching column sits at the same position. A relation with no foreign key, or a foreign key with no relation, is silent.

**Removed:** `Crud.Ui` (moves to `crud-ui`), the `ui` import, `CRUD_MODEL_FILTER_*`, `CRUD_MODEL_SORT_*`.

**Docs:**
- `modules/crud/docs/model.md` becomes `collection.md`, and `resource.md` becomes `api.md`.
- The list-route doc (`list-route.md`, name kept) gains facet requests and `absent`.
- `modules/crud/docs/ui.md` moves to crud-ui.
- Update `README.md`, and crud's `metadata.description` and both kind descriptions (hub text, no kind names).

**Verify:**
- A relation from `posts.authorId` to authors, with a foreign key pointing at a different table, is refused by `telo check` and again at start.
- The same relation with the matching foreign key passes.
- `GET /api/posts?facet=authorId&title.contains=x` answers the present author ids, with counts, for posts matching the filter.
- `GET /api/employees?managerId.absent=true` answers only the employees with no manager.
- Rules are pinned in `modules/crud/tests/`, both ways.
- `crud`'s `telo.yaml` declares no filter or sort rule and imports no `ui`.

## 4. `ui`

### Removed

- `Ui.Collection`, outright, with no alias and no migration.
- `Ui.Table`, outright, with no alias and no migration. `Ui.Listing` with the default layout replaces it; the table's `columns` move to `Ui.TableLayout`, and `rowKey` is gone (the listing reads the collection's `key`).
- `Ui.Filters.model`: the bar's shape is the collection's `model`. `UI_FILTER_UNKNOWN_PROPERTY`, `UI_FILTER_OPERATOR_UNSUPPORTED` and `UI_FILTER_MODEL_INCOMPLETE` go with it; the `DATA_MODEL_*` rules guarantee the same things.
- The `table` branch of the page spec, replaced by `listing`.

### How a collection is reached and presented

- **`Ui.CollectionSource`**: a collection as the browser reaches it.
  - `collection` is a `DataModel.Collection`, `use: dependency`.
  - `basePath` is an app-relative URL.
  - It carries no relations, so an option source pointing at it can never form a cycle.
- **`Ui.CollectionPresentation`**: how one set of screens shows a collection.
  - `source` is a `!ref` to a `Ui.CollectionSource`.
  - `relations` is `<property>: { source, label, hint?, href?, search?, pageSize? }`, through the named shape `Relations`. Each entry holds presentation only:
    - `source` is the `Ui.CollectionSource` the related records are read from, `use: dependency`;
    - `label`, `hint` and `href` are accessors over `row`, typed from the source collection's `model`;
    - `search` and `pageSize` mean what they mean on `Ui.CollectionOptions`.
  - A relation's value is never written: it is always the target's `key`, from the data model, and `DATA_MODEL_RELATION_KEY_NOT_FILTERABLE` already guarantees it can be looked up with `in`.
- **`Ui.CollectionOptions`** (changed):
  - `source` is now a `!ref` to a `Ui.CollectionSource`, replacing `collection` plus `source.basePath`.
  - The fixed equalities that were `source.filters` become top-level `filters`.
  - `model`, `value`, `label`, `hint`, `href`, `search` and `pageSize` stay.
- **`Ui.Listing`, `Ui.Filters` and `Ui.Form`** take `presentation`, a `Ui.CollectionPresentation`. It replaces `Ui.Table.collection` + `source.basePath`, `Ui.Filters.collection`, and `Ui.Form.source`. `Ui.Form.model` stays: the write shape.

### `Ui.Listing`

A composite that owns everything that does not depend on how records are drawn:

| Key | | |
| --- | --- | --- |
| `presentation` | required | a `Ui.CollectionPresentation` |
| `model` | required | the row shape |
| `filters` | none | fixed equalities, as `Ui.Table.source.filters` were |
| `query` | none | a `Ui.QueryParameters` |
| `pageSize` | 25 | records per read: each page, each group, each period, each tree level; 1–100 |
| `paging` | `pages` | how further pages are reached: `pages` (a pager), `more` (a "Load more" control), `scroll` (more, loaded when the end comes into view) |
| `rowStyle` | none | styles the record's element in every layout: table row, card, event, bar |
| `create` / `edit` | none | `{ form, surface?, afterSubmit?, unsaved? }`, unchanged |
| `delete` | none | unchanged |
| `rowActions` | none | a list of `Ui.RowAction` |
| `empty` | the word for "no records" | a node drawn where the records would be when the listing's reads answer none |
| `layout` | `{ kind: Ui.TableLayout }` | how records are drawn; a kind under `Ui.ListingLayout`, `use: call` |
| `compact` | none | the layout used below the application's breakpoint; same slot type as `layout` |

- Both slots declare a region binding `row` (typed from `model`) and `query`; layout kinds type their own bindings from it with `x-telo-context-from-referrer`.
- Layout kinds carry no `compact` of their own, so a compact layout cannot be nested.
- Crossing the breakpoint swaps the layout and keeps the listing's state: an open edit form stays open.
- **Paging:**
  - `paging` is the listing's, not the layout's: `layout` and `compact` both follow it.
  - `pages` keeps the cursors already read, so "previous" replays a page, as the table does today. It applies to the table, list and cards layouts.
  - `more` and `scroll` append each next page to what is shown. `scroll` keeps the "Load more" control at the end, focusable, so keyboard and screen-reader users and anything below the listing stay reachable.
  - Board columns and tree levels always load more, whatever `paging` says, since a pager means nothing there. A calendar or timeline period reads all of its pages.
  - The shown count comes from `total`, never from the records loaded.
- **The viewer's sort** is listing state over the collection's `query.sort`. Each layout draws the choice its own way (table headers; a sort control on list, cards, board and tree). Calendar and timeline draw no control but still send the sort.
- **Selection** is not part of this work. Its home is the listing, and every layout's record entry already carries a selected state, so it is added later by adding keys.

### `Ui.ListingLayout` and the layouts

`Ui.ListingLayout` is an abstract `Telo.Invocable`, the same seam `Ui.Field` uses. Called by the listing with `{ model, collection, relations }`, it answers `{ problems, spec?, assets }`. The listing raises `ERR_<code>` for each problem. Statically, each layout's fit is a referrer rule on `Self.Listing`.

Each layout declares only its own drawing and read keys; a key foreign to it is `SCHEMA_VIOLATION`.

| Kind | Keys | Reads |
| --- | --- | --- |
| `Ui.TableLayout` | `columns` (as today) | pages |
| `Ui.ListLayout` | `content` | pages |
| `Ui.CardLayout` | `content`, `size` (`small \| medium \| large`, default `medium`) | pages |
| `Ui.BoardLayout` | `groups` (required), `content`, `move?` | one per group |
| `Ui.CalendarLayout` | `span` (required), `period` (`month \| week \| day`, the initial one), `content`, `move?` | per shown period |
| `Ui.TimelineLayout` | `span` (required), `groups?` (lanes), `scale` (`day \| week \| month \| quarter`), `content`, `move?` | per shown period, per lane |
| `Ui.TreeLayout` | `parent`, `content`, `move?` | roots, then children on expand |
| `Ui.ComponentLayout` | `component`, `props`, `groups?`, `span?`, `parent?`, `move?` | as its plan says |

- `content` is one node tree drawn per record over `row`, the same key on every layout that has it.
- `groups`, `span` and `move` each use one named shape: `Ui.Grouping` `{ property, values: all | present }`, `Ui.Span` `{ start, end? }`, and `Ui.RowAction`.
- `groups.property`, `span.start` / `end` and `parent` are property names, like `query.filters[].property`, because they are sent on the wire.
- A gallery is `Ui.CardLayout` with an `image` node; a feed is `Ui.ListLayout`; master/detail is any layout with an `edit` opener on a `Ui.Panel`.
- A board's column counts come from each column's `total`. The facet request is needed only for `values: present`.
- Map and chart are not built-ins. A map needs a geographic value type and a `within` operator; until then a module ships one through `Ui.ComponentLayout` over paged reads. A chart shows totals, not records, so it is not a listing layout.

### The read plan

Every layout's data needs are one closed, declarative plan, `reads`: three optional dimensions that compose as a product. The renderer executes it, so code never chooses a query, and `telo check` judges every request a layout can send against the collection.

- **`groups`**: one read per group value, each adding `<property>=<value>`.
  - `present` takes the values from the facet request, which carries the active filters.
  - `all` takes them from the property's `enum`, or a boolean's two values, or else the relation's source, paged.
- **`span`**: each read adds the shown period's bounds.
  - Without `end`: `<start>.gte` and `<start>.lte`.
  - With `end`: the overlap pair `<start>.lte` and `<end>.gte`.
- **`parent`**: roots are read with `<parent>.absent=true`, and an expanded record's children with `<parent>=<key>`, when it is expanded.

Every read is paged by `pageSize` and carries the listing's `filters`, the bar's filters and the viewer's sort.

### Moving a record

Dragging a card to another column, rescheduling or resizing an event, and reparenting a tree item are one gesture, `move`. It is a `Ui.RowAction` whose region binds `row` (the record as read) and `to` (the record as the gesture leaves it, typed from `row` through `x-telo-context-from-referrer: row`).

- The gesture fills `to` and runs the action. It is never a replace through the edit form, which would lose one of two concurrent moves.
- The action's `inputs` are checked as call-site arguments with the existing codes (`CONTRACT_INPUTS_MISMATCH`, `CEL_UNKNOWN_FIELD`, `CEL_TYPE_ERROR`, `ACCESSOR_NOT_PLAIN_CHAIN`), twinned by `ERR_UI_ROW_ACTION_INPUTS_INVALID`.
- A 2xx answer is an invalidation of the source's `basePath` (below).
- Every move has a keyboard path: a "Move to" menu, drawn with `Menu`. Drag-and-drop is composition; there is no new control.
- Order within a column is the listing's sort. There is no manual rank.

### Behaviour shared by every layout

- **Labels:** a table column or a `value` node over `row.<property>` with a relation shows the related record's label, linked where the relation gives `href`. One label engine serves every read: it collects the keys from every page answered in one render turn, including every column of a board, and requests them per relation with `in`, in batches of the relation's `pageSize`, skipping keys already labelled.
- **Invalidation:** a write, a delete, a row action, a move, `notifyChanged(basePath)` and `Ui.Action.onSuccess.refreshes` reload every listing whose presentation's source has that `basePath` (every group, every period, every loaded tree level), and every facet request over it: a `values: present` filter field's values and counts, and a `present` board column's. A notify on a relation's source `basePath` reloads that relation's labels. `refreshes` matches `Ui.Data.source.path` and `Ui.CollectionSource.basePath`.
- **The reload rule**, one rule for every reload, whatever causes it:
  - A reload keeps what the viewer has scrolled to. It refetches the loaded pages in order from the first, since a cursor is opaque, and draws them together when all have answered.
  - With more than 10 pages loaded in one read (a list, a column, a level), only that read's first page is refetched, in place; the later pages stay as drawn and the viewer is never returned to page one. A record the write or move itself answered with is replaced from that answer wherever it is drawn.
  - Records are matched by the collection's `key`. A record whose key remains keeps its element, so its focus, open inline surface, expanded tree state and an edit form's entered values stay. A changed record is updated in place, records that left the answer go, and new ones appear in order.
  - A filter or sort change is not a reload: it returns each read to its first page.
- **Filter bar:** every listing inside a `Ui.Filters` bar's `content` obeys the bar, in any layout. A change returns each read to its first page, and the facet request behind `values: present` groups carries the bar's other filters.
- **Filter fields:** a field over a property with a relation offers the related records, read from the relation's `source` and drawn with its `label` and `hint`.
- **Present values:** a filter field takes `values: all | present`, default `all`. The screen decides; declaring a facet on the data model never changes a screen by itself.
  - `present` offers only the values that occur, from the facet request. The request carries the other active filters, never the field's own, and each value is shown with its count.
  - Related keys are labelled through the relation (or the field's `options`), one batched `in` request per facet page.
  - It works for any faceted property, a relation or not (an enum, for example).
- **Override:** `Ui.Filters.fields[].options` (any `Ui.OptionSource`) replaces where a field's choices and labels come from. `values` still decides whether all of them or only the present ones are offered.
- **`absent` in a filter bar:** `Ui.controlFits` maps it to `toggle`.
- **Form:** a field for a property with a relation is derived as a `Ui.PickerField` over the relation. An explicitly written field wins.

### Rules

Each has an `ERR_` twin.

| Code | Kind | When |
| --- | --- | --- |
| `UI_RELATION_UNDECLARED` | `Ui.CollectionPresentation` | a relation names a property the collection declares no relation for |
| `UI_RELATION_TARGET_MISMATCH` | `Ui.CollectionPresentation` | the entry's `source.collection` is not the relation's target |
| `UI_RELATION_SEARCH_NOT_ACCEPTED` | `Ui.CollectionPresentation` | the entry's `search` is not a filter pair the target collection declares |
| `UI_FILTER_OPTION_VALUE_MISMATCH` | `Ui.Filters` | an overriding `options`'s value type is not the property's |
| `UI_FILTER_VALUES_NOT_FACETED` | `Ui.Filters` | `values: present` on a property the collection does not list under `query.facets` |
| `UI_OPTION_VALUE_NOT_FILTERABLE` | `Ui.CollectionOptions` | kept, now resolved through `/source/collection` |
| `UI_SOURCE_FILTER_UNKNOWN_PROPERTY`, `UI_SOURCE_FILTER_NOT_ACCEPTED` | `Ui.Listing`, `Ui.CollectionOptions` | kept, over the top-level `filters` |
| `UI_LAYOUT_PROPERTY_UNKNOWN` | every layout with the key | `groups.property`, `span.start`, `span.end` or `parent` names a property the listing's `model` does not declare |
| `UI_LAYOUT_GROUP_UNSUPPORTED` | board, timeline, component | the grouped property does not hold one plain value |
| `UI_LAYOUT_GROUP_NOT_FILTERABLE` | board, timeline, component | the collection does not accept `{ property, eq }` for it |
| `UI_LAYOUT_GROUPS_NOT_FACETED` | board, timeline, component | `values: present` on a property not listed under `query.facets` |
| `UI_LAYOUT_GROUPS_NOT_ENUMERABLE` | board, timeline, component | `values: all` on a property with no `enum`, not a boolean, and with no relation the presentation presents |
| `UI_LAYOUT_SPAN_NOT_DATE` | calendar, timeline, component | `start` / `end` is not a string of `format: date` or `date-time`, or the two differ in format |
| `UI_LAYOUT_SPAN_NOT_FILTERABLE` | calendar, timeline, component | without `end`, the collection lacks `{start, gte}` or `{start, lte}`; with `end`, it lacks `{start, lte}` or `{end, gte}` |
| `UI_LAYOUT_PARENT_NOT_SELF_RELATION` | tree, component | `parent` has no relation whose target is the listing's own collection |
| `UI_LAYOUT_PARENT_NOT_FILTERABLE` | tree, component | the collection lacks `{parent, eq}` or `{parent, absent}` |

The `UI_LAYOUT_*` rules are referrer rules on `Self.Listing`, resolving the collection through `/presentation/source/collection`. The listing raises each one's twin from the layout's `problems`.

### Wire

- The page spec gains `type: listing`, with `schema`, `basePath`, `key`, `query`, `filters`, `pageSize`, `paging`, `sort` (the sortable properties), `rowStyle`, `create`, `edit`, `delete`, `rowActions`, `relations`, `empty`, `layout` and `compact?`.
- `Ui.ListingLayoutSpec` is a closed, renderer-neutral union tagged `table`, `list`, `cards`, `board`, `calendar`, `timeline`, `tree`, `component`. Every branch carries `reads` `{ groups?, span?, parent? }`. `ui` fills every default.

### Docs

- `table.md` is replaced by `listing.md` and `listing-layouts.md`.
- New `collection-source.md` and `collection-presentation.md`.
- Updated `filters.md`, `form.md`, `field-kinds.md`, `nodes.md` (an unbounded set points at `Ui.Listing`) and `README.md`.
- "Layout is not a field anywhere" in the module's docs, and "There is no layout field" in `nodes.md`, are reworded to say that spacing (gap, alignment, width) is not a field.
- Links to the collection docs point at `data-model`.

### Conformance

- `control-fits.json` gains `absent` rows.
- New `modules/ui/conformance/listing-reads.json`, shipped through `files:`, pinning the exact requests each `reads` produces: a board column, a month period with and without `end`, tree roots and tree children, the next page under `more`, the reload of three loaded pages, and the reload of twelve (first page only).

### Verify

- In the authors/posts example, the posts listing shows author names in a table, in cards and on a board.
- The author filter offers every author by default. With `values: present` it offers only authors who have posts, with counts.
- Adding `authorId` to the posts collection's `query.facets` leaves a filter bar without `values: present` unchanged. `values: present` on an unfaceted property is `UI_FILTER_VALUES_NOT_FACETED`.
- The post form shows an author picker.
- One authors URL is written once and used by both the authors screens and the posts picker.
- A self-relation (`employees.managerId`) and a mutual pair (`authors.featuredPostId` ↔ `posts.authorId`) pass `telo check` with no cycle and render labels. The employees drawn as a tree read roots with `managerId.absent=true`.
- A presentation whose relation's `source` reads another collection is `UI_RELATION_TARGET_MISMATCH`.
- Omitting `layout` gives a spec byte-equal to `layout: { kind: Ui.TableLayout }`.
- A listing with a `compact` card layout keeps its open edit form when the viewport crosses the breakpoint.
- A board drag runs the move action with `to.<property>` set. Afterwards, a board and a cards listing over the same `basePath` both reload, and a `values: present` filter field over that `basePath` shows the new counts.
- An edit form open on one record keeps its entered values across a reload caused by moving another record.
- With 12 pages loaded, a write reloads the first page in place, leaves the viewer where they were, and shows the written record from the write's answer.
- A list layout with `paging: scroll` loads the next page when its end comes into view, and through its "Load more" control from the keyboard. A write after three loaded pages re-reads all three and keeps the scroll position; a filter change returns it to the first page.
- No kind in `ui` names a concrete layout from another module.
- Every rule is pinned in `modules/ui/tests/`, both ways. The renderer conformance rows cover a relation column, a faceted filter field, a derived picker, and every `listing-reads.json` row.

## 5. `ui-react` and `ui-react-radix`

- **`ui-react`** renders `type: listing` and the seven built-in layouts, executing `reads` and running paging, the label engine, invalidation, openers, row actions and moves. Under `more` and `scroll` it draws only the records in view, so a long list stays fast however far it is scrolled.
- **`ui_react_layouts-1`** is a new, fully controlled renderer contract for `Ui.ComponentLayout`, like `ui_react_controls-2`. It is published as a data file beside `controls.json`, with vectors and scenes, and exported through `@telorun/ui-react-contract`.
  - The renderer owns fetching, paging, filters, invalidation, label batching, openers, row actions, delete, running a move, each record's actions element and the open inline surface.
  - The component receives the records (each `{ key, row, props, labels, actions }`); `groups` (each `{ value, label, total, records, hasMore }`), the `span` period, tree children and `sort`, each when the plan has them; and `loading` and `error`.
  - It reports intents only: `onEndReached` (per group or level), `onPeriodChange`, `onExpand`, `onOpen(key)`, `onSortChange`, `onMove(key, to)`, and `onCreate(values)`, where `values` is limited to the plan's own properties (a column's group value, a clicked day).
  - Each prop is an accessor: a row-bound prop is delivered per record, a fixed one once.
  - The built-in layouts are its reference implementation.
  - A layout export's ABI family is checked at start with `ERR_UI_COMPONENT_ABI_UNSUPPORTED`, as for `Ui.Component`.
  - `ui_react-1` and `ui_react_controls-2` are unchanged.
- **`ui-react-radix`** styles the new parts: listing, layouts, the "Load more" control, the "Move to" menu and the empty state.

**Docs:** new `modules/ui-react/docs/layouts-abi.md`; the renderer docs gain the listing and the layouts.

**Verify:**
- The built-in layouts pass the `ui_react_layouts-1` vectors and every `listing-reads.json` row. A vector pins `onEndReached` on a list layout.
- A layout kind in a fixture module, extending `UiKit.ComponentLayout` with `base:`, is accepted at `layout` with no change to `ui`. Given a `groups.property` the collection does not filter by `eq`, it is refused by `telo check`.

## 6. `crud-ui`

- **`CrudUi.CollectionSource`** extends `UiKit.CollectionSource`, narrowing `collection` to `Crud.Collection`, so the admin can read the collection's operation shapes with their types.
- **`CrudUi.Admin`** is today's `Crud.Ui`. It takes `source` (a `CrudUi.CollectionSource`), `relations`, `filters`, `create`, `edit`, and optional `layout` / `compact` (both `UiKit.ListingLayout`) and `paging`, each forwarded whole to the generated listing; omitted, they mean the listing's defaults. Its own `layout` region types `row` from the collection's list shape.
- It expands into its own `Ui.CollectionPresentation`, `Ui.Listing`, `Ui.Filters` and two `Ui.Form`s. The ejected output reads like hand-written `ui`.
- A board's `move` names an action the author declares, because crud serves no move route.

Moved from crud: the tests `ui-eject`, `ui-refusals` and `ui-renamed-property` and their fixtures go to `modules/crud-ui/tests/`, and the docs go to `modules/crud-ui/docs/admin.md`. Also add `README.md`, `LICENSE` and `license: MIT`.

**Verify:**
- The moved tests pass under their new names.
- An admin over the posts collection shows author names, the faceted author filter and the author picker, with nothing restated beyond `relations`.
- An admin with `layout: { kind: UiKit.BoardLayout, groups: { property: status } }` renders one column per value of the `status` enum.

## 7. Migrating in-repo users (by hand)

Update every in-repo user to the new kinds and keys; every `Ui.Table` becomes a `Ui.Listing`, every `Crud.Model` a `Crud.Collection`, every `Crud.Resource` a `Crud.Api`. Instances named after the old kinds are renamed (`todoModel` → `todos`, the API instance → `todosApi`), so no instance name says "model" for a collection:
- `examples/todo-app` and its tests;
- `starters/apps/todo` and its tests;
- `examples/ui-showcase`;
- every `ui` / crud test and fixture;
- `pages/static/examples.md`.

Add an authors/posts example to `examples/ui-showcase`, over SQLite, with a foreign key. It draws posts as a table, as cards and on a board by status, and adds a calendar listing over a dated collection.

**Verify:**
- No `Ui.Collection`, `UiKit.Collection`, `Ui.Table`, `UiKit.Table`, `Ui.CollectionView`, `view:` presentation key, `Crud.Ui`, `Crud.Model`, `Crud.Resource`, `CrudUi.Source`, `CRUD_MODEL_`, `rowKey`, or `model:` key on a `Crud.Api` remains in the repo outside changelogs.
- Across the `data-model`, `ui`, `crud` and `crud-ui` schemas, every property named `model` holds a `Telo.Type` reference and every property named `collection` a reference to a `DataModel.Collection` or a kind extending it; a test walking the schemas pins this.
- `Crud.Collection` and `CrudUi.CollectionSource` are each accepted at their base kind's slot (`DataModel.Collection`, `UiKit.CollectionSource`) with no change to `data-model` or `ui`.
- `pnpm run test --include 'modules/data-model/tests/*.yaml' --include 'modules/ui/tests/*.yaml' --include 'modules/crud/tests/*.yaml' --include 'modules/crud-ui/tests/*.yaml' --include 'modules/sql/tests/*.yaml' --include 'modules/sqlite/tests/*.yaml'` passes, and so do the `ui-react` and `ui-react-radix` package tests.
- The example and starter suites pass for the touched apps.

## 8. Guides, primer, ledger

- **`apps/hub/guides/build-ui.md`**: collection source and presentation, relations, facets, the listing and its layouts, `compact`, `move`, `Ui.ComponentLayout`, `absent`, `CrudUi.Admin`.
- **`apps/authoring-agent/chat/primer.md`**: the four-module split, `DataModel.Collection`, relations, the listing and its layouts, `compact`, `move`, `Ui.ComponentLayout`, `absent`, `Crud.Collection`, `Crud.Api` and its `collection:` key, `CrudUi.CollectionSource`, and the removal of `Ui.Collection`, `Ui.Table` and `Crud.Ui`.
- **`docs/guides/what-you-get.md`**, under Standard library:
  - "Filter and pick by related record": dropdowns and pickers of related records are labelled by name, can offer only the records present (with counts), and a relation that contradicts its foreign key is refused before the app runs.
  - "Show a collection any way": openers, actions and filters declared once, drawn as a table, cards, a board, a calendar, a timeline or a tree, with a compact layout on narrow screens, paged or infinitely scrolled; a layout needing a filter the API does not accept is refused before the app runs.
- **`docs/guides/what-you-get.md`**, under For module authors: ship a layout of your own through `Ui.ComponentLayout`.
- **`modules/CLAUDE.md`**: a stdlib note on the `data-model` / `ui` / `crud` / `crud-ui` split and its import directions. The Declarative UI paragraph is rewritten from table to listing and layouts, and the CRUD paragraph uses `Crud.Collection`, `Crud.Api` and `CrudUi.CollectionSource`.
- **`modules/data-model/docs/`** link to crud's `collection.md` and `api.md`.

## 9. Checks to run before building on them

Each was confirmed by reading code, not by running it. Check each with a minimal manifest first. Where one fails, the generic extension it names is part of this work, never a per-kind workaround:

1. A `resolve:` pointer in a resource rule can cross reference slots and range with `*` over a map, reaching a field that only an extending kind declares (`/relations/*/collection/table`).
2. A `use: schema` target is available as its declaration when the referrer is created, so the `ERR_` twins need no init order (as the sql foreign-key slot already relies on).
3. A template-forward path through two reference slots (`self.source.collection.schemas.list`) is followed and typed. If it isn't, extending template-forward resolution to do so is part of this work.
4. A referrer rule on a layout resolves `/presentation/source/collection` (three slots) and reads its `query`, `relations` and `model`.
5. A referrer rule can tell that a relation's target is the same declaration as the listing's collection. If resolved data carries no identity, rule resolution gains the resolved declaration's address.
6. `x-telo-context-from-referrer` accepts a referrer binding of another name, so `to` takes the type of `row`.
7. An inline layout written at `CrudUi.Admin.layout` is typed and forwarded through the template to a `use: call` slot.

A merge-form child narrowing an inherited field (`key: const id`) is already supported by the extends rules.

## Releases

One fragment per module, each written with `telo release add`, each body naming only its own module:

| Module | Kind | What the body says |
| --- | --- | --- |
| `data-model` | `Added` | new module, with the `absent` operator |
| `sql` | `Added` | typed foreign-key entry |
| `postgres` | `Fixed` | foreign keys documented |
| `sqlite` | `Fixed` | foreign keys documented |
| `crud` | `Added`, describing the break | `Crud.Model` renamed `Crud.Collection` and `Crud.Resource` renamed `Crud.Api`, whose `model` key becomes `collection`; `CRUD_MODEL_*` codes renamed `CRUD_COLLECTION_*`; extends `DataModel.Collection`; `schemas.read` becomes `model`; `table` required and the API's `table` removed; facet and `absent` answers; the foreign-key rule; filter/sort rules moved to `data-model`; `Crud.Ui` moved to `crud-ui` |
| `ui` | `Added`, describing the break | `Ui.Collection` and `Ui.Table` removed; collection source and presentation added; `Ui.Listing` and its layouts; `presentation` on listing/filters/form; top-level `filters`; `Ui.Filters.model` removed; relation labels, `values: present` filter fields, derived pickers, moves |
| `ui-react` | `Added` | the listing renderer, the seven layouts, `ui_react_layouts-1` |
| `ui-react-radix` | `Added` | styles for the listing, the layouts and the move menu |
| `crud-ui` | `Added` | new module, with `layout` / `compact` |

A changeset goes on each changed package that changesets versions, per `.changeset/config.json`.

**`requires:` floors:** this work adds no new grammar; `absent` and the layouts are the modules' own vocabulary. A module gets a floor only if running the previous published CLI against it, with the block stripped, rejects it; restoring the block must then give `MODULE_REQUIRES_NEWER_RUNTIME`. `crud` keeps `>=0.123.0`.
