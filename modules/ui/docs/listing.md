# Ui.Listing

The records of a REST collection, read page by page and drawn by a layout.
Everything that does not depend on how records are drawn is the listing's —
what is read, paging, the viewer's sort, labels of related records, the
create and edit buttons, row actions, delete and the empty state — so it is declared once whatever the
layout. How records are drawn is [the layout's](listing-layouts.md).

| Field | | |
| --- | --- | --- |
| `presentation` | required | the [`Ui.CollectionPresentation`](collection-presentation.md) shown, `!ref` or inline |
| `model` | required | the shape of one record: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `form` | none | the [`Ui.Form`](form.md) the listing [follows](#following-a-form), read as `form` |
| `filters` | | property → a fixed value or a path into `query`, [`params`](page.md#params) or `form`: equalities applied to every request, each a filter the collection accepts with `eq` and typed against its model property — a key the model does not declare is refused by `telo check` (`SCHEMA_VIOLATION`); while one holds nothing the listing reads nothing |
| `query` | none | the page query parameters its filters and row actions read, a [`Ui.QueryParameters`](conditions.md); read as `query` |
| `pageSize` | `25` | records per read, 1–100, sent as `limit` |
| `paging` | `pages` | how further pages are reached: [`pages`, `more` or `scroll`](#paging) |
| `reloadEvery` | none | how often the records are [read again on a timer](#timed-reload), a duration of at least `5s` |
| `sort` | the collection's order, chosen by the viewer | [the order the records start in and whether the viewer may change it](#sorting): `{ by?: { property, direction? }, choosable? }` |
| `show` | `{ count: true }` | [what is shown beside the records](#the-count): `{ count? }` |
| `rowStyle` | | a [style rule](nodes.md#style-rules) for the record's element in every layout: a table row, a card, an event |
| `create` | | [the create button](#create-and-edit): `{ to, label? }`, a [`Ui.Press`](presses.md#presses) with an optional `label`, over `values`, `query` and `params` |
| `edit` | | [the edit action of each record](#create-and-edit): `{ to, label? }` over `row`, `query` and `params` |
| `press` | what `edit`'s `to` says | [what pressing a record does](#pressing-a-record): a [`Ui.Press`](presses.md#presses), `{ to, label }`, over `row`, `query` and `params` |
| `delete` | `false` | whether each record offers a [confirmed delete](#delete): `false`, `true`, or `{ onSuccess?, onFailure? }` |
| `rowActions` | none | [operations each record offers](#row-actions): a [`Ui.MutationCall`](mutation.md#uimutationcall) each |
| `rowActionsDisplay` | `auto` | [how the actions, edit and delete are drawn](#how-the-actions-are-drawn): `auto`, `inline` or `menu` |
| `empty` | the text `noRows`, "No rows." | a [node](nodes.md) drawn where the records would be when the reads answer none |
| `layout` | a table | how the records are drawn: [a layout kind](listing-layouts.md), `!ref` or inline |
| `compact` | none | the layout drawn below the application's breakpoint; same kinds as `layout` |

The collection is the presentation's source's: its `key` identifies a record
in item URLs and across reloads, its `query.sort` is what the viewer may sort
by, and whatever serves it speaks
[the collection contract](https://hub.telo.run/module/oci/ghcr.io/telorun/data-model/).

```yaml
kind: Ui.Listing
metadata: { name: postsList }
presentation: !ref postsPresentation
model: !ref Post
pageSize: 20
create:
  to: { kind: Ui.OpenPage, page: !ref newPostPage }
edit:
  to: { kind: Ui.OpenPage, page: !ref postPage, pathParams: { id: !cel "row.id" }, surface: { kind: Ui.Drawer } }
delete: true
```

With `layout` left out the records are drawn as a table with one column per
model property but the key; the listing then provides exactly what it
provides with `layout: { kind: Ui.TableLayout }`.

## Compact

`compact` names the layout drawn below the application's breakpoint — the same
kinds as `layout`, which carry no `compact` of their own:

```yaml
layout: { kind: Ui.BoardLayout, groups: { property: status } }
compact: { kind: Ui.CardLayout, size: small }
```

Crossing the breakpoint swaps the layout and keeps the listing's state: the
pages read, the viewer's sort, an open page and what it holds.

## Paging

`paging` is the listing's, so `layout` and `compact` both follow it:

- `pages` — a pager. The cursors already read are kept, so "previous" replays a
  page. It applies to the table, list and cards layouts.
- `more` — a "Load more" control (`ui`'s text `loadMore`) appending
  the next page to what is shown.
- `scroll` — the next page is loaded when the end comes into view; the "Load
  more" control stays at the end, focusable, so keyboard and screen-reader
  users and anything below the listing stay reachable.

A board's columns and a tree's levels always load more, whatever `paging`
says, since a pager means nothing there; a calendar's or a timeline's shown
period reads all of its pages. Every read — a page, a group, a period, a tree
level — reads `pageSize` records at a time. The shown count comes from the
answer's `total`, never from the records loaded.

## Sorting

The viewer's sort is listing state over the collection's `query.sort`, sent as
`sort` on every read. Each layout draws the choice its own way — a table
through its column headers, a list, cards, a board and a tree through a sort
control; a calendar and a timeline draw none but still send the sort.

`sort` fixes the starting order and, optionally, the choice:

```yaml
sort:
  by: { property: updatedAt, direction: descending }
  choosable: false
```

`by.property` is a property the collection lists under `query.sort`, and
`direction` is `ascending` (the default) or `descending`. Until the viewer
chooses another order the listing sends it as `sort` on every read — `-updatedAt`
above — and the layout's sort starts at it. `choosable: false` draws no sort
control and no sortable table header, so the order is the listing's alone;
`{ choosable: false }` without `by` keeps the collection's own order. A
property the collection does not list is refused (`UI_LISTING_SORT_NOT_ACCEPTED`).

## The count

`show: { count: false }` hides the pager's range text (`pager-status`) in every
paging mode and words each group's heading — a board column, a grouped list —
with its label alone. The pager's buttons stay.

## How the actions are drawn

Row actions, edit and delete are drawn the same way in every layout, as
`rowActionsDisplay` says. `inline` draws each as a button on its record. `menu`
folds them into one icon button (the glyph `more`, named by the text
`rowActionsMenu`, "Actions") opening a menu of the row actions, then edit, then
delete, each labelled by its call's `label`, `edit` and `delete`. An entry
whose `enabled` condition does not hold is a disabled item, its `disabledText`
the item's hint; a `confirm` or `prompt` opens as it does from a button, with
the focus returning to the menu button. A pressed call's answer is drawn in
the record's actions before the menu button, a failure beside it.

`auto` is one judgement for the whole listing, so the rows stay aligned, made
from the room each drawn record gives its own actions and never from the
viewport: inline when, for every record, the buttons laid in one line fit that
room, a menu as soon as one record lacks it. The room is the record's own
content box (a card, a board card, a calendar event), or half of it where the
record's content shares the line with its actions (a list row); in a table it is
the grid, which must fit its frame with the buttons inline. A small card in a
wide listing is therefore a menu while a wide row in the same listing is
buttons. It is judged again when a record's size, the records drawn or the
actions change. Once a menu, it becomes inline again only at a container wider
than the one that lacked the room by at least what it lacked.

## The selected record

A record whose press, or a link its layout draws, leads to where the viewer
is — the listing's `press`, a column's `to`, a `link` node in a layout's
`content`, a value the model calls a `uri` — is the selected record: its
element carries `data-selected="true"` (in a table, its row) and the layout
contract's `selected` is true; a component layout's `selected` reports the
press alone. A relation's label links and a row action's answer are never
counted. The rule
that decides what is current, a stray parameter unmarking a link included, is
in [nodes](nodes.md#the-current-location). A chat's conversation list is
this: rows linking to `/?conversation=<id>` mark the open conversation.

## The empty state and row styles

`empty` is drawn where the records would be when the listing's reads answer
none — every group, period or level of a layout reading several. `rowStyle`
styles the element each record is drawn in, whatever the layout: a table row, a
list item, a card, an event, a bar.

## Related records

Where the presentation presents a property's relation, a value over
`row.<property>` shows the related record's label instead of its key, linked
where the relation gives `to`. The listing's node carries each presented
relation under `relations`, keyed by property, as the
[option source](field-kinds.md#option-sources) its labels are read
from: the keys of every page answered in one render turn are looked up with
`in`, in batches of the relation's `pageSize`, skipping keys already labelled.

## Create and edit

A record's create screen and edit screen are [`Ui.Page`](page.md)s, and `create`
and `edit` are presses whose destination is usually a
[`Ui.OpenPage`](presses.md#uiopenpage) of that page: the page reached by its own
address is a full page, and opened from a press it is drawn in the press's
[surface](surfaces.md). `create` is drawn as the listing's create button; `edit`
is drawn among each record's actions, and is the record's press when `press` is
omitted.

```yaml
create:
  to: { kind: Ui.OpenPage, page: !ref newPostPage, surface: { kind: Ui.Dialog, size: small } }
edit:
  to:
    kind: Ui.OpenPage
    page: !ref postPage
    pathParams: { id: !cel "row.id" }
    surface: { kind: Ui.Panel, address: { name: post }, compact: { kind: Ui.Drawer, side: bottom } }
  label: Edit post
```

| Field | | |
| --- | --- | --- |
| `to` | required | where pressing goes, a [destination](presses.md#destinations); `edit`'s reads `row` |
| `label` | `ui`'s text `create` / `edit` | the [`Ui.BoundText`](texts.md#a-text-over-data) naming the button |

**What a place proposes for the new record.** `create` reads `values`, the
property values the place that asked proposes — a board's column its
grouping value, a calendar day its start — typed as the listing's `model` with
every member optional and nullable (`values.status` may hold nothing, a name
the model lacks is `CEL_UNKNOWN_FIELD`), and `{}` from the listing's own button.
It is an accessor root, so a destination reads it only in accessor fields such
as `queryParams`; a parameter whose value holds nothing is left out of the
address, and `values` outside a `create` is `CEL_UNKNOWN_IDENTIFIER`.

```yaml
create:
  to:
    kind: Ui.OpenPage
    page: !ref newTaskPage                  # declares `query: { status }`, starts its form from it
    queryParams: { status: !cel "values.status" }
```

Each key is typed from [`Ui.Press`](presses.md#presses), whose `label` is
required where a press has no default. The old object spelling
`{ form, surface, afterSubmit, unsaved }` is `SCHEMA_VIOLATION`: a form lives
on a page, which says its own lifecycle ([the form](form.md)).

## Pressing a record

Without `press`, pressing a record does what `edit`'s `to` says. `press` says what
pressing one does instead — a [destination](presses.md) and the label naming
the press, both over the record's `row` and the listing's `query` and
`params` — and editing is then the record's edit button:

```yaml
press:
  to:
    kind: Ui.OpenPage
    page: !ref postPage
    pathParams: { id: !cel "row.id" }
    surface: { kind: Ui.Drawer, side: end, address: { name: post } }
  label: { text: "Open {$title}", values: { title: !cel "row.title" } }
edit:
  to: { kind: Ui.OpenPage, page: !ref postPage, pathParams: { id: !cel "row.id" } }
```

Every layout draws the press across the whole record — a list item, a card, a
board card, a calendar or timeline event, a tree item — except a table, which
draws it across [the row's first cell](listing-layouts.md#uitablelayout). The
record's own links, buttons and row actions stay targets of their own above
it. A record press is the listing's own `press` and is never set by another
resource; a related record's label goes where its
[relation's `to`](collection-presentation.md#relations) says, in every listing
over the presentation.

A `to` reading a property the model does not declare, and a `label` value
doing so, are `CEL_UNKNOWN_FIELD`; a press with no `label` is
`SCHEMA_VIOLATION`.

## Row actions

`rowActions` puts buttons on every record, in the order written, before edit
and delete. Each is a [`Ui.MutationCall`](mutation.md#uimutationcall) running a
[`Ui.Mutation`](mutation.md) with values of that record, of the listing's
declared `query`, of the page's [`params`](page.md#params) and of the
[form it follows](#following-a-form):

```yaml
rowActions:
  - mutation: !ref archiveTodo
    inputs:
      id: !cel "row.id"
      status: archived
    label: Archive
    confirm: Archive this task?
```

| Field | | |
| --- | --- | --- |
| `mutation` | required | the [`Ui.Mutation`](mutation.md) run, `!ref` or inline |
| `inputs` | required | the record sent, by input property: a path into `row`, `query`, `params`, `form` or `prompt`, or a fixed value; `{}` for a mutation that takes nothing |
| `label` | required | the button's accessible name; include the text it shows |
| `confirm` | | a question asked first; left out, a press runs the write at once, unless `prompt` opens a dialog |
| `prompt` | none | a [`Ui.Prompt`](#asking-for-more) the press opens before the write is sent |
| `enabled` | always | when the record's button can be pressed, over `row`, `query` and `params`, and why not |
| `onSuccess` | none | [effects](mutation.md#after-a-success) run once the write succeeds |
| `onFailure` | none | [effects](mutation.md#after-a-success) run when the write does not succeed, over `error` and `input` |
| `result` | nothing drawn | a node tree drawn in place of the button after a success, over `result` and `input` |
| `failure` | the error's code and message | a node tree drawn beside the button when the write does not succeed, over `error` and `input` |

The button shows the call's `label` and sends
[the mutation's request](mutation-contract.md#from-bound-inputs) to its `url`,
filled from the inputs. Every property the mutation's `inputModel` requires is
bound here. A record takes no press while its last is pending or queued. Once
the write succeeds, the listings whose collection source has the same `basePath`
reload, the call's `result` tree is drawn in place of its button — kept while
that record is shown, through the reload — and its `onSuccess` effects run; a
failure draws its `failure` tree beside the button, or in the confirmation when
one was open. The mutation's `concurrency` applies wherever it runs.

### Asking for more

`prompt` opens a dialog on the press, titled with `confirm` — or with the call's
label when there is no question — and holding the fields of a
[`Ui.Prompt`](mutation.md#asking-first): a reason, a note, a date. What was
entered is read by `inputs` as `prompt`.

```yaml
rowActions:
  - mutation: !ref reject            # inputModel: { id, reason }
    inputs: { id: !cel "row.id", reason: !cel "prompt.reason" }
    label: Reject
    confirm: Reject this request?
    prompt:
      kind: Ui.Prompt
      model:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [reason]
          properties: { reason: { type: string, title: Reason } }
```

- The dialog's fields are the prompt's own: the ones it lists, or every property
  of its `model` a control can enter. Each is drawn as a form draws it.
- What is entered is checked in the page against the prompt's `model` before
  anything is sent: a required field left empty blocks sending. A 400 the
  operation answers is shown on the dialog's fields.
- Every input the mutation requires is bound in `inputs`; one left unbound is
  `CONTRACT_INPUTS_MISMATCH`, and `prompt.reason` on a call with no prompt is
  `CEL_UNKNOWN_IDENTIFIER`. `prompt: true` is `SCHEMA_VIOLATION`.

Each entry's `inputs` is checked as a record of **its own** mutation's
`inputModel`, so two entries over different models do not mix:

| Written | Reported |
| --- | --- |
| a key a closed input model does not declare, a required input left out, a fixed value of the wrong type | `CONTRACT_INPUTS_MISMATCH` |
| `!cel "row.<name>"` for a property the row model does not declare, `query.<name>` for a parameter the listing does not declare | `CEL_UNKNOWN_FIELD` |
| a path whose type the input property does not take (`row.name`, a string, for an integer `id`) | `CEL_TYPE_ERROR` |
| anything but a plain path (`!cel "row.id + 1"`) | `ACCESSOR_NOT_PLAIN_CHAIN` |
| no `label`, a `confirm` that is not text or is empty | `SCHEMA_VIOLATION` |
| a `confirm` naming a placeholder it does not bind (`{ text, values }` binds them) | `MESSAGE_PLACEHOLDER_UNBOUND` |

The listing refuses a record's inputs itself when it is first read, as
`ERR_UI_MUTATION_CALL_INPUTS_INVALID`: a key a closed input model does not
declare, a required input left unbound, or a fixed value its property refuses.

## Delete

`delete: true` offers a confirmed delete. Written as `{ onSuccess?, onFailure? }`
it also runs [effects](toasts.md#where-effects-are-written) once the delete
answers, each a list over `row` — and `error` in `onFailure` — beside `query`
and `params`:

```yaml
delete:
  onSuccess:
    - kind: Ui.Toast
      text: { text: "{$name} deleted.", values: { name: !cel "row.name" } }
  onFailure:
    - kind: Ui.Toast
      text: { text: "Could not delete {$name}: {$message}", values: { name: !cel "row.name", message: !cel "error.message" } }
```

A failed delete keeps its confirmation open with the failure drawn in it, as a
row action's confirmation does, and a failure toast adds to it.

## Following a form

`form: !ref <form>` names a [`Ui.Form`](form.md) placed elsewhere on the page and
binds the `form` root — the form's settled, valid record, typed from its `model`
— in the listing's `filters` and row actions. A board that follows a team
choice is a form with a `team` field and a listing with
`filters: { team: !cel "form.team" }`; the listing reads each column again when
the team changes, and reads nothing while the form has never held a valid
record. `form` read where the listing names no form is `CEL_UNKNOWN_IDENTIFIER`.
The listing node carries the form's id as `form`, `null` when none. The rules are
those of [a query that follows a form](form.md#a-query-that-follows-a-form).

## Reloading

A write, a delete, a row action, a [move](listing-layouts.md#moving-a-record),
`notifyChanged(basePath)` and a mutation's `invalidates` reload every
listing whose presentation's source has that `basePath` — every group, every
period and every loaded tree level — and every facet request over it: a
`values: present` filter field's values and counts, and a `present` board's
columns. A notify on a relation's source `basePath` reloads that relation's
labels.

**What a success announces.** After a 2xx a call announces the resolved path
of its mutation's `url` and of each `invalidates` entry; in a listing
it announces the listing's own `basePath` too, and a listing's own item write
(create, edit, delete, move) announces the item path (`<basePath>/<key>`) as
well. A `Ui.Query`, `Ui.Listing` or `Ui.Chat` reads again exactly when the
resolved, encoded, app-relative path of its request equals an announced one;
the query is not compared. A `Ui.Query.url` and a `Ui.CollectionSource.basePath`
— a templated one as it resolves — are matched this way.

**A refused precondition.** A `DELETE` or a row action answered `412` (the
record changed since it was read, for a path whose read carried an `ETag`)
announces the item path and the listing's own `basePath` as a success does, so
the listing reads again and shows the record as it now is. A form's `PATCH` answered
`412` announces the item path, so the record is read again. The form
or dialog that was open shows the failure and keeps what was entered
([preconditions](mutation-contract.md#preconditions)).

One rule for every reload, whatever causes it:

- A reload keeps what the viewer has scrolled to. It refetches the loaded pages
  in order from the first, since a cursor is opaque, and draws them together
  when all have answered.
- With more than 10 pages loaded in one read (a list, a column, a level), only
  that read's first page is refetched, in place; the later pages stay as drawn
  and the viewer is never returned to page one. A record the write or move
  itself answered with is replaced from that answer wherever it is drawn.
- Records are matched by the collection's `key`. A record whose key remains
  keeps its element, so its focus, its open inline surface, its expanded tree
  state and an open form's entered values stay. A changed record is updated in
  place, records that left the answer go, and new ones appear in order.
- A reload that fails keeps what is drawn and shows the failure beside it.
- A filter or sort change is not a reload: it returns each read to its first
  page.

The requests a reload sends are pinned by
[`conformance/listing-reads.json`](../conformance/README.md).

## Timed reload

`reloadEvery: 30s` reads the listing again every interval while it is shown,
under the reload rule above: the loaded pages refetched in order — the first
page only past ten — and records matched by `key`, so focus, open surfaces,
expanded state and entered values stay. Every group, period and loaded level
is read again, and the facet requests over its source with it.

- A tick is skipped while a read of the listing is in flight, and is not run
  while the document is hidden; coming back to visibility reads once if an
  interval has passed. A listing hidden by `shown` reads nothing.
- A tick that fails keeps what is drawn and shows the failure beside it; the
  next tick tries again.
- It is a literal: a value below `5s` is refused by `telo check`
  (`SCHEMA_VIOLATION`) and when the listing is created
  (`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`).

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_SOURCE_FILTER_NOT_ACCEPTED` | `filters` names a property the collection's `query.filters` does not declare with operator `eq` |
| `UI_LISTING_SORT_NOT_ACCEPTED` | `sort.by.property` is not a property of the collection's `query.sort` |

What a layout needs of the listing — a grouping, a span or a parent the
collection can filter by — is refused at the listing too, by the layout's
[`UI_LAYOUT_*` rules](listing-layouts.md#refused).

A `filters` key naming a property the model does not declare is refused by
the key's own type (`SCHEMA_VIOLATION`).

The listing refuses the same things itself when it is first read
(`ERR_UI_SOURCE_FILTER_UNKNOWN_PROPERTY`, `ERR_UI_SOURCE_FILTER_NOT_ACCEPTED`,
`ERR_UI_LISTING_SORT_NOT_ACCEPTED`),
for a manifest that never passed `telo check`, and raises `ERR_<code>` for
each problem its layout answers.

## The node

What the listing provides is a `type: listing` node carrying `schema`,
`basePath`, `key`, `query`, `filters`, `pageSize`, `paging`, `sort`
(`{ sortable, initial }`: the properties the viewer may sort by — none when the
order is fixed — and the order sent until they choose, `-` leading a descending
one, or null), `show` (`{ count }`), `rowStyle`, `create`, `edit`, `delete` (`false`, or `{ onSuccess, onFailure }` effect specs),
`rowActions`, `rowActionsDisplay`, `relations`, `empty`, `layout`, `compact`,
`press` (a [`Ui.PressSpec`](presses.md#what-a-renderer-receives), `null` when
none is written) and `reloadEvery` (the interval in milliseconds, present when
set) — every default filled by `ui`.
`basePath` is the source's literal path or its [template](collection-source.md#a-templated-base-path).
`layout` and `compact` are [`Ui.ListingLayoutSpec`](listing-layouts.md#the-layout-spec)
values.
