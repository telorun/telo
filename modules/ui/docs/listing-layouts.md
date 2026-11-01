# Listing layouts

A listing's `layout` (and its `compact`) names how its records are drawn: a
kind under the abstract `Ui.ListingLayout`. A layout declares only its own
drawing and read keys — a key foreign to it is `SCHEMA_VIOLATION` — while
everything else — what is read, paging, the viewer's sort, labels of related
records, openers, row actions, delete — is [the listing's](listing.md), so it is
declared once whatever the layout.

```yaml
kind: Ui.Listing
metadata: { name: tasks }
presentation: !ref tasksPresentation
model: !ref Task
layout:
  kind: Ui.BoardLayout
  groups: { property: status }
compact: { kind: Ui.CardLayout }
```

| Kind | Keys | Reads |
| --- | --- | --- |
| [`Ui.TableLayout`](#uitablelayout) | `columns` | pages |
| [`Ui.ListLayout`](#uilistlayout) | `content` | pages |
| [`Ui.CardLayout`](#uicardlayout) | `content`, `size` | pages |
| [`Ui.BoardLayout`](#uiboardlayout) | `groups` (required), `content`, `move` | one per group |
| [`Ui.CalendarLayout`](#uicalendarlayout) | `span` (required), `period`, `content`, `move` | per shown period |
| [`Ui.TimelineLayout`](#uitimelinelayout) | `span` (required), `groups`, `scale`, `content`, `move` | per shown period, per lane |
| [`Ui.TreeLayout`](#uitreelayout) | `parent` (required), `content`, `move` | roots, then children on expand |
| [`Ui.ComponentLayout`](#uicomponentlayout) | `component` (required), `props`, `groups`, `span`, `parent`, `move` | as its keys say |

- A **gallery** is `Ui.CardLayout` with an `image` node in its `content`; a
  **feed** is `Ui.ListLayout`; **master/detail** is any layout with an `edit`
  opener on a [`Ui.Panel`](surfaces.md), the record opening beside the list.
- **A map and a chart are not built-ins.** A map needs a geographic value type
  and a `within` operator; until then a module ships one through
  `Ui.ComponentLayout` over paged reads. A chart shows totals, not records, so
  it is no listing layout.

## `Ui.ListingLayout`

An abstract `Telo.Invocable`, the seam a field kind uses: the listing calls its
layout with `{ model, collection, relations }` — its row model; its
collection's record shape, key, accepted query, identity and the target of each
relation it declares; and the related records it labels — and the layout
answers `{ problems, spec?, assets }` (`Ui.ListingLayoutAnswer`): `spec` exactly
when `problems` is empty, plus the files a browser loads for it. The listing
raises `ERR_<code>` for the first problem. Statically, a layout's fit to the
listing using it is a referrer rule on that listing, so `telo check` reports
what the call refuses — and a layout kind from another module is checked with
no change to `ui`.

Both `layout` and `compact` bind `row` (typed from the listing's `model`) and
`query` for the layout's accessors; a layout kind types its own bindings from
them with `x-telo-context-from-referrer`. A layout kind carries no `compact` of
its own, so a compact layout cannot be nested.

## Shared keys

- **`content`** — one [node](nodes.md) tree drawn per record, over `row` and
  `query`; the same key on every layout drawing records with it. Omitted, a
  stack of the record's values, one `value` node per model property but the
  collection's key, in declaration order. A `value` node over `row.<property>`
  where the presentation presents that property's relation shows the related
  record's label.
- **`groups`** — a `Ui.Grouping`, `{ property, values }`: one read per value of
  `property`, each adding `<property>=<value>`. `values` is `all` (the default)
  — the property's `enum`, `null` aside, or a boolean's two, else the related
  records of the relation the presentation presents for it, paged from its
  source — or `present`, the values the facet request answers under the
  listing's and the bar's filters, each with its count. A group's count is its
  read's `total`; the facet request is needed only for `present`.
- **`span`** — a `Ui.Span`, `{ start, end? }`: the `date` or `date-time`
  properties a record starts and ends at, both of one format. Each read adds
  the shown period's bounds — without `end`, `<start>.gte` and `<start>.lte`
  (the records starting in it); with `end`, the overlap pair `<start>.lte` and
  `<end>.gte` (the records overlapping it).
- **`parent`** — the property holding the key of a record's parent, a relation
  of the collection to itself. The roots are read with `<parent>.absent=true`,
  an expanded record's children with `<parent>=<key>`.
- **`move`** — a [`Ui.RowAction`](action.md#row-actions) over `row`, the record
  as read, and `to`, the record as the gesture leaves it (typed from `row`).

`groups.property`, `span.start` / `end` and `parent` are property names, as a
collection's `query.filters[].property` is, because they are sent on the wire.

## Moving a record

Dragging a card to another column, rescheduling or resizing an event, and
reparenting a tree item are one gesture: the layout's `move`. The gesture fills
`to` — the record with the column's value, the new dates, the new parent — and
runs the action with the inputs written over `row` and `to`:

```yaml
layout:
  kind: Ui.BoardLayout
  groups: { property: status }
  move:
    action: !ref setTaskStatus
    inputs:
      id: !cel "row.id"
      status: !cel "to.status"
```

- It is never a replace through the edit form, which would lose one of two
  concurrent moves.
- `inputs` is checked as a call site of the action, as a row action's is:
  `CONTRACT_INPUTS_MISMATCH`, `CEL_UNKNOWN_FIELD`, `CEL_TYPE_ERROR` and
  `ACCESSOR_NOT_PLAIN_CHAIN` at `telo check`, and
  `ERR_UI_ROW_ACTION_INPUTS_INVALID` when the listing is first read.
- A 2xx answer is a change to the collection: every listing over its source's
  `basePath` [reloads](listing.md#reloading).
- Every move has a keyboard path: each record's "Move to" menu (the renderer's
  `moveTo` word), drawn with `Menu`, offering the places the gesture could
  drop it. Drag and drop is composition; there is no control of its own.
- Order within a column is the listing's sort. There is no manual rank.

## `Ui.TableLayout`

Records as a data grid.

| Field | | |
| --- | --- | --- |
| `columns` | derived | the columns, left to right; omitted, one per model property but the collection's key, in declaration order |

A column is exactly one of:

```yaml
columns:
  - header: Task                 # optional
    value: !cel "row.text"       # an accessor: a chain into the record, or a fixed value
    style:                       # optional style rule for the cell
      by: !cel "row.priority"
      cases: { "1": danger }
  - header: State
    cell:                        # a Ui.Component drawn in the cell
      kind: Ui.Component
      component: !ref Badges.statusPill
      model: !ref Todo
      props: { done: !cel "row.isDone" }
```

`row` is typed from the listing's `model`, so a property the model does not
declare is `CEL_UNKNOWN_FIELD` at `telo check`.

Whether written or derived, a value column takes everything else from the
property its value names:

- **Header** — the property's `title`, else its name, unless `header` is given.
- **Sorting** — a column is sortable exactly when its value is `row.<property>`
  and the collection's `query.sort` lists that property.
- **Related record** — a column whose value is `row.<property>`, where the
  presentation presents that property's relation, shows the related record's
  label, linked where the relation gives `href`.
- **Presentation** — from the property's `type` and `format`: a boolean as Yes
  or No, a `format: date` string as a date, and so on. A `format: uri` or
  `uri-reference` string is a link, where its value is an address
  [a `link` node's `href` may hold](nodes.md#addresses); a value that is not is
  shown as plain text. A link to a page of the application moves within it;
  any other opens beside it.

So a hand-written `value: !cel "row.dueOn"` and the derived column for `dueOn`
are the same column.

### Members behind a reference

A column over a nested member (`row.owner.site`) takes its header and its
presentation from that member however the model reaches it. Every node on the
way, and the member itself, is read as the shape it names: a named shape
(`!ref File`), a pointer into the model's own definitions
(`$ref: "#/$defs/File"`, resolved in the shape it is written in), or a shape
reached through another, as deep as the references go. A keyword written
beside a reference — a `title` on the member — wins over the same keyword of
the shape it names. A union or an `allOf` on the way is not read, and the
column then shows the member's name and plain text.

A reference on the way to a column's member that names nothing, or leads back
to itself, is `ERR_REF_UNRESOLVED` when the listing is first read, naming the
layout and the place in `model`. `telo check` does not report it.

## `Ui.ListLayout`

Records one under another, each drawn with `content` — a feed.

| Field | | |
| --- | --- | --- |
| `content` | derived | the node drawn per record |

## `Ui.CardLayout`

Records as a grid of cards, each drawn with `content`. A gallery is a card
layout whose content holds an `image` node.

| Field | | |
| --- | --- | --- |
| `content` | derived | the node drawn per record |
| `size` | `medium` | how wide a card is: `small`, `medium` or `large` |

## `Ui.BoardLayout`

A kanban board: a column per group, each read and paged on its own — a column
always loads more, whatever the listing's `paging` says, since a pager means
nothing there.

| Field | | |
| --- | --- | --- |
| `groups` | required | the [grouping](#shared-keys) records are drawn in columns by |
| `content` | derived | the node drawn per card |
| `move` | none | the operation moving a card to another column |

## `Ui.CalendarLayout`

Records on the days of a month, a week or a day. A shown period reads all of
its pages.

| Field | | |
| --- | --- | --- |
| `span` | required | the [date properties](#shared-keys) a record starts and ends at |
| `period` | `month` | the period shown first: `month`, `week` or `day`; the viewer moves between periods and changes it |
| `content` | derived | the node drawn per event |
| `move` | none | the operation rescheduling or resizing an event |

## `Ui.TimelineLayout`

Records as bars along time, optionally in a lane per group. A shown period
reads all of its pages, per lane.

| Field | | |
| --- | --- | --- |
| `span` | required | the [date properties](#shared-keys) a bar starts and ends at |
| `groups` | none | the [grouping](#shared-keys) records are laid in lanes by |
| `scale` | `month` | the time a column spans: `day`, `week`, `month` or `quarter`; the viewer changes it |
| `content` | derived | the node drawn per bar |
| `move` | none | the operation moving or resizing a bar |

## `Ui.TreeLayout`

Records as a hierarchy: the roots, then each record's children when it is
expanded. A level always loads more, whatever the listing's `paging` says.

| Field | | |
| --- | --- | --- |
| `parent` | required | the [property](#shared-keys) holding a record's parent's key |
| `content` | derived | the node drawn per record |
| `move` | none | the operation reparenting a record |

```yaml
layout:
  kind: Ui.TreeLayout
  parent: managerId          # employees.managerId → employees
  content: { type: value, value: !cel "row.name" }
```

## `Ui.ComponentLayout`

Records drawn by a browser component of your own — a map, a seat plan — over
the reads its keys declare. The renderer still owns fetching, paging, filters,
reloads, label lookups, openers, row actions, delete and running a move; the
component receives the records and reports what the viewer asks for.

| Field | | |
| --- | --- | --- |
| `component` | required | a [`Ui.ComponentExport`](component-export.md) whose entry is written against the renderer's layout component contract |
| `props` | `{}` | what the component receives, by name: a fixed value, given once, or a path into `row`, given per record; held to the export's `props` |
| `groups`, `span`, `parent` | none | the [read plan](#shared-keys) |
| `move` | none | the operation a move the component reports runs |

A renderer refuses at start an export whose entry declares another ABI than the
layout contract it hosts (`ERR_UI_COMPONENT_ABI_UNSUPPORTED`), as it does for a
`Ui.Component`.

A layout of another module is a kind extending `Ui.ComponentLayout` with
`base:` — its own keys mapped onto the component, its plan and its props — and
is accepted at `layout` with no change to `ui`. A `base:` child inherits no
rule, so it declares the referrer rules its keys need on its own schema; the
listing still raises `ui`'s twin of each when it is first read.

## Refused

Each a referrer rule on the listing using the layout (`REFERRER_RULE_VIOLATED`,
in `data.rule`), resolving the collection through
`/presentation/source/collection`; the listing raises its `ERR_` twin from the
layout's `problems` when it is first read.

| Rule | Layouts | When |
| --- | --- | --- |
| `UI_LAYOUT_PROPERTY_UNKNOWN` | every layout with the key | `groups.property`, `span.start`, `span.end` or `parent` names a property the listing's `model` does not declare |
| `UI_LAYOUT_GROUP_UNSUPPORTED` | board, timeline, component | the grouped property does not hold one plain value |
| `UI_LAYOUT_GROUP_NOT_FILTERABLE` | board, timeline, component | the collection does not accept `{ property, operator: eq }` for it |
| `UI_LAYOUT_GROUPS_NOT_FACETED` | board, timeline, component | `values: present` on a property the collection does not list under `query.facets` |
| `UI_LAYOUT_GROUPS_NOT_ENUMERABLE` | board, timeline, component | `values: all` on a property with no `enum`, not a boolean, and with no relation the presentation presents |
| `UI_LAYOUT_SPAN_NOT_DATE` | calendar, timeline, component | `start` / `end` is not a string of `format: date` or `date-time`, or the two differ in format |
| `UI_LAYOUT_SPAN_NOT_FILTERABLE` | calendar, timeline, component | without `end`, the collection lacks `{start, gte}` or `{start, lte}`; with `end`, it lacks `{start, lte}` or `{end, gte}` |
| `UI_LAYOUT_PARENT_NOT_SELF_RELATION` | tree, component | `parent` has no relation whose target is the listing's own collection |
| `UI_LAYOUT_PARENT_NOT_FILTERABLE` | tree, component | the collection lacks `{parent, eq}` or `{parent, absent}` |

A layout written inline at a kind that forwards it to the listing its body
generates is judged against that listing's collection, at the place the
consumer wrote it.

## The layout spec

What a layout answers is a `Ui.ListingLayoutSpec`: a closed, renderer-neutral
union tagged on `type` — `table`, `list`, `cards`, `board`, `calendar`,
`timeline`, `tree` and `component` — every branch carrying `reads`, the
listing's read plan, three optional dimensions composing as a product:

| `reads` member | What is read |
| --- | --- |
| `groups: { property, values, enum?, relation?, labels }` | one read per group value, each adding `<property>=<value>`: under `present` the facet answer's values; under `all` the listed `enum`, or the related records of `relation`, paged from its source |
| `span: { start, end?, format }` | each read adds the shown period's bounds, written as a `date` or a `date-time` |
| `parent` | roots with `<parent>.absent=true`, an expanded record's children with `<parent>=<key>` |

A renderer executes the plan, so code never chooses a query. Every read is
paged by the listing's `pageSize` and carries its `filters`, the filter bar's
filters and the viewer's sort; a table, a list and cards read pages alone, with
`reads: {}`. The exact requests a plan sends — a board column, a period with and
without `end`, tree roots and children, the next page, a reload — are pinned by
[`conformance/listing-reads.json`](../conformance/README.md).

| Branch | Members beside `type` and `reads` |
| --- | --- |
| `table` | `columns`, each `{ header, value?, labels, sort?, relation?, present?, style?, cell? }` — `relation` naming the key of the listing's `relations` its value is labelled through |
| `list` | `content` |
| `cards` | `content`, `size` |
| `board` | `content`, `move?` |
| `calendar` | `period`, `content`, `move?` |
| `timeline` | `scale`, `content`, `move?` |
| `tree` | `content`, `move?` |
| `component` | `module`, `export`, `abi?`, `external`, `stylesheets`, `props`, `move?` |

`move` is a row action as a renderer receives it, its action provided. `ui`
fills every default, so a renderer reads none of its own.
