# Ui.Listing

The records of a REST collection, read page by page and drawn by a layout.
Everything that does not depend on how records are drawn is the listing's —
what is read, paging, the viewer's sort, labels of related records, openers,
row actions, delete and the empty state — so it is declared once whatever the
layout. How records are drawn is [the layout's](listing-layouts.md).

| Field | | |
| --- | --- | --- |
| `presentation` | required | the [`Ui.CollectionPresentation`](collection-presentation.md) shown, `!ref` or inline |
| `model` | required | the shape of one record: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `filters` | | property → a fixed value or a path into `query` or [`params`](page.md#params): equalities applied to every request, each a filter the collection accepts with `eq` and typed against its model property — a key the model does not declare is refused by `telo check` (`SCHEMA_VIOLATION`); while one holds nothing the listing reads nothing |
| `query` | none | the page query parameters its filters and row actions read, a [`Ui.QueryParameters`](conditions.md); read as `query` |
| `pageSize` | `25` | records per read, 1–100, sent as `limit` |
| `paging` | `pages` | how further pages are reached: [`pages`, `more` or `scroll`](#paging) |
| `reloadEvery` | none | how often the records are [read again on a timer](#timed-reload), a duration of at least `5s` |
| `sort` | the collection's order, chosen by the viewer | [the order the records start in and whether the viewer may change it](#sorting): `{ by?: { property, direction? }, choosable? }` |
| `show` | `{ count: true }` | [what is shown beside the records](#the-count): `{ count? }` |
| `rowStyle` | | a [style rule](nodes.md#style-rules) for the record's element in every layout: a table row, a card, an event |
| `create`, `edit` | | [how a form is opened](#opening-a-form): `{ form, surface?, afterSubmit?, unsaved? }` |
| `delete` | `false` | whether each record offers a confirmed delete |
| `rowActions` | none | [operations each record offers](#row-actions): `{ action, inputs, confirm?, prompt?, enabled? }` each |
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
create: { form: !ref postForm }
edit: { form: !ref postForm, surface: { kind: Ui.Drawer } }
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
pages read, the viewer's sort, an open edit form and what it holds.

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
delete, each labelled by its action's `label`, `edit` and `delete`. An entry
whose `enabled` condition does not hold is a disabled item, its `disabledText`
the item's hint; a `confirm` or `prompt` opens as it does from a button, with
the focus returning to the menu button. A pressed action's answer is drawn in
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

A record whose layout draws a link that leads to where the viewer is — a
column's `href`, a `link` node in a layout's `content`, a value the model
calls a `uri` — is the selected record: its element carries
`data-selected="true"` and the layout contract's `selected` is true. A
relation's label links and a row action's answer are never counted. The rule
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
where the relation gives `href`. The listing's node carries each presented
relation under `relations`, keyed by property, as the
[option source](field-kinds.md#option-sources) its labels are read
from: the keys of every page answered in one render turn are looked up with
`in`, in batches of the relation's `pageSize`, skipping keys already labelled.

## Opening a form

`create` adds a record and `edit` changes one. Each is an object naming the
form and, optionally, where and how it opens:

```yaml
create:
  form: !ref todoForm
edit:
  form: !ref todoForm
  surface: { kind: Ui.Panel, address: { name: todo } }
  afterSubmit: keep
  unsaved: discard
```

| Field | | |
| --- | --- | --- |
| `form` | required | a [`Ui.Form`](form.md), `!ref` or inline |
| `surface` | a `Ui.Dialog` with its defaults | [where the form appears](surfaces.md): any `Ui.Surface`, `!ref` or inline |
| `afterSubmit` | `close` | what the form does once the record is saved: `close`, `keep`, and on `create` also `again` — back at the values a new record starts from |
| `unsaved` | `confirm` | whether leaving the form with unsaved input asks first (`confirm`) or drops it (`discard`) |

An edit opens over the record read by its key, not over the record shown.
`afterSubmit` and `unsaved` are described with the surfaces, under
[After a submit, and unsaved input](surfaces.md#after-a-submit-and-unsaved-input).

The object is the only spelling: `create: !ref todoForm` is refused
(`SCHEMA_VIOLATION`), as is `afterSubmit: again` on `edit`.

## Row actions

`rowActions` puts buttons on every record, in the order written, before edit
and delete. Each is a [`Ui.BoundAction`](action.md#bound-actions) running a
[`Ui.Action`](action.md) with values of that record, of the listing's
declared `query` and of the page's [`params`](page.md#params):

```yaml
rowActions:
  - action: !ref archiveTodo
    inputs:
      id: !cel "row.id"
      status: archived
    confirm: Archive this task?
```

| Field | | |
| --- | --- | --- |
| `action` | required | the [`Ui.Action`](action.md) run, `!ref` or inline |
| `inputs` | required, at least one | the record sent, by input property: a path into `row`, `query` or `params`, or a fixed value |
| `confirm` | | a question asked first; left out, a press runs the action at once, unless `prompt` opens a dialog |
| `prompt` | `false` | whether a press opens a dialog that [asks for more](#asking-for-more) before the action is sent |
| `enabled` | always | when the record's button can be pressed, over `row`, `query` and `params`, and why not; the action's own `enabled` does not govern it |

The button shows the action's `label` and sends
[its request](action-contract.md#from-bound-inputs) to its `request.target`, filled from the inputs. Every
property the action's `inputModel` requires is bound here. A record takes no
press while its last is pending or queued. Once the operation succeeds, the
listings whose collection source has the same `basePath` reload, the action's
`result` tree is drawn in place of its button — kept while that record is
shown, through the reload — and its `onSuccess` applies; a failure draws its
`failure` tree beside the button, or in the confirmation when one was open.

### Asking for more

`prompt: true` opens a dialog on the press, titled with `confirm` — or with the
action's label when there is no question — and holding a field for each of the
action's [`fields`](action.md) that `inputs` does not bind: a reason, a note,
a date.

```yaml
rowActions:
  - action:
      kind: Ui.Action
      inputModel: !ref Rejection      # { id (required), reason }
      request: { target: /api/reject }
      label: Reject
    inputs:
      id: !cel "row.id"
    confirm: Reject this request?
    prompt: true                      # the dialog asks for `reason`
```

- The fields are the action's own: the ones it lists, or every property a
  control can enter, less those the record binds. Each is drawn as a form
  draws it.
- The record sent is what the dialog entered with the record's `inputs` over
  it. A field left empty is left out.
- What is entered is checked in the page, with the bound values, against the
  whole input model before anything is sent, as a form's is: a required field
  left empty blocks sending.
- With `prompt: true`, a property the input model requires may be left unbound
  for the person to enter; without it, `inputs` binds every one. A 400 the
  operation answers is shown on the dialog's fields.
- With every field of the action bound by the record, the dialog holds none and
  is a confirmation.

Each entry's `inputs` is checked as a record of **its own** action's
`inputModel`, so two entries over different models do not mix. `telo check`
names that model "the declared inputType" of the action:

| Written | Reported |
| --- | --- |
| a key a closed input model does not declare, a required input left out by an entry that does not prompt, a fixed value of the wrong type | `CONTRACT_INPUTS_MISMATCH` |
| `!cel "row.<name>"` for a property the row model does not declare, `query.<name>` for a parameter the listing does not declare | `CEL_UNKNOWN_FIELD` |
| a path whose type the input property does not take (`row.name`, a string, for an integer `id`) | `CEL_TYPE_ERROR` |
| anything but a plain path (`!cel "row.id + 1"`) | `ACCESSOR_NOT_PLAIN_CHAIN` |
| no `inputs`, an empty one, a `confirm` that is not text or is empty | `SCHEMA_VIOLATION` |
| a `confirm` naming a placeholder it does not bind (`{ text, values }` binds them) | `MESSAGE_PLACEHOLDER_UNBOUND` |

The listing refuses a record's inputs itself when it is first read, as
`ERR_UI_BOUND_ACTION_INPUTS_INVALID`: a key a closed input model does not
declare, a required input left unbound, or a fixed value its property refuses.

## Reloading

A write, a delete, a row action, a [move](listing-layouts.md#moving-a-record),
`notifyChanged(basePath)` and an action's `onSuccess.refreshes` reload every
listing whose presentation's source has that `basePath` — every group, every
period and every loaded tree level — and every facet request over it: a
`values: present` filter field's values and counts, and a `present` board's
columns. A notify on a relation's source `basePath` reloads that relation's
labels.

**What a success announces.** After a 2xx an action announces the resolved path
of its `request.target` and of each `onSuccess.refreshes` entry; in a listing
it announces the listing's own `basePath` too, and a listing's own item write
(create, edit, delete, move) announces the item path (`<basePath>/<key>`) as
well. A `Ui.Data`, `Ui.Listing` or `Ui.Chat` reads again exactly when the
resolved, encoded, app-relative path of its request equals an announced one;
the query is not compared. A `Ui.Data.source` and a `Ui.CollectionSource.basePath`
— a templated one as it resolves — are matched this way.

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
  state and an edit form's entered values stay. A changed record is updated in
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
one, or null), `show` (`{ count }`), `rowStyle`, `create`, `edit`, `delete`,
`rowActions`, `rowActionsDisplay`, `relations`, `empty`, `layout`, `compact` and `reloadEvery` (the
interval in milliseconds, present when set) — every default filled by `ui`.
`basePath` is the source's literal path or its [template](collection-source.md#a-templated-base-path).
`layout` and `compact` are [`Ui.ListingLayoutSpec`](listing-layouts.md#the-layout-spec)
values.
