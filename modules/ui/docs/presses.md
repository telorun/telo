# Presses and destinations

What happens when something is pressed is written once, in one vocabulary: a
**destination**, held by the key `to`. The same destination goes to the same
place from a link, a menu item, a column, a related record's label, a
navigation entry, a call's success and a pressed region — a card, a
listing's record, a group of nodes.

```yaml
- type: link
  text: Full page
  to: { kind: Ui.Navigate, href: { path: !ref postPage, pathParams: { id: !cel "row.id" } } }
- type: link
  text: About the author
  to: { kind: Ui.OpenPage, page: !ref authorPage, pathParams: { id: !cel "data.authorId" } }
```

## Destinations

A destination is a `Ui.Destination` — an abstract whose kinds provide where a
press goes, and which extends `Ui.Effect`, so a destination is also an
[effect](#effects). `ui` has two:

| Kind | Goes |
| --- | --- |
| [`Ui.Navigate`](#uinavigate) | to an address |
| [`Ui.OpenPage`](#uiopenpage) | to a page of the application, opened over the current one in any surface |

Every destination has an address, so a renderer draws every `to` as a link to
it: it opens in a new tab like any link, and for a `Ui.OpenPage` that is the
opened page's own address, an unmodified click opening it in place.

### `Ui.Navigate`

| Field | |
| --- | --- |
| `href` | required: an [address](nodes.md#addresses) — a literal, a page reference, or a path template with its `pathParams` and `queryParams` |

An app-relative address of a page the application lists is a move within the
application, any other address an ordinary load; an address that does not
resolve goes nowhere.

### `Ui.OpenPage`

| Field | |
| --- | --- |
| `page` | required: the [`Ui.Page`](page.md) opened, by `!ref` — one the application lists in its pages |
| `pathParams` | the value of each `{name}` of the page's `path`, as an [address's](nodes.md#addresses) |
| `queryParams` | the parameters appended to the page's address, as an address's |
| `surface` | where it opens: any [`Ui.Surface`](surfaces.md#the-abstracts) — a `Ui.Dialog`, `Ui.Drawer`, `Ui.Popover`, `Ui.InlineSurface`, `Ui.Panel` or a kind of your own extending it. Omitted, the surface it is pressed in, else a dialog |

The page is named, never held: two pages may open each other. Its variables
are checked against its own `path` — a missing one is `PATH_PARAMETER_UNBOUND`,
one it lacks `PATH_PARAMETER_UNUSED` — and a page the application does not list
is `UI_PAGE_UNROUTED`, as a link to it would be. How a page opens in a surface
— one opened page at a time, an omitted `surface` keeping the one it is pressed
in — is in [surfaces](surfaces.md#a-page-opened-in-a-surface).

## Effects

What follows a successful write is a list of `Ui.Effect`s: the `onSuccess` of a
[call](mutation.md#after-a-success) and of a [form](form.md#onsuccess). `Ui.Effect`
is an abstract, so an effect kind another module adds is accepted with no change
to the call; anything that is not an effect there is `REFERENCE_KIND_MISMATCH`.
Today the effects are the destinations, `Ui.Navigate` and `Ui.OpenPage`. They run
in the order written, each after the one before has happened, and are run by the
page shell, so they run even after the component that made the call has closed.

## The `to` key

`to` holds a destination declared in place: a `{ kind, … }` of a
`Ui.Destination` kind. Anything else there — a surface, a field kind — is
`REFERENCE_KIND_MISMATCH`, and a kind no module declares is refused as any
unknown kind is.

| Where | Reads |
| --- | --- |
| a [`link`](nodes.md) node, a [`menu`](nodes.md#menus) item | the roots of the tree it is in |
| a [`value`](nodes.md#values-and-lists) node | the roots of the tree it is in |
| a [`list`](nodes.md#values-and-lists) column | `row`, and the roots the list is drawn under |
| a [`Ui.TableLayout`](listing-layouts.md#uitablelayout) column | `row` and `params` |
| a [relation](collection-presentation.md#relations) | `row`, the related record |
| an [option source](field-kinds.md#option-sources) | `row`, the option's record |
| a [navigation](navigation.md#entries--uinavigationitem) `link` entry | nothing: every value is fixed |
| a call's or form's [`onSuccess`](mutation.md#after-a-success), as an [effect](#effects) | `result` and `input`; a form's, `values` and `result` |
| a [press](#presses) on a `box`, `stack` or `columns` node | the roots of the tree it is in |
| a [`Ui.Listing`'s press](listing.md#pressing-a-record), `edit` | `row`, `query` and `params` |
| a [`Ui.Listing`'s `create`](listing.md#create-and-edit) | `values`, `query` and `params` |

### The roots a destination reads

A destination's accessors — `href`, `pathParams`, `queryParams` — read the
roots bound where its `to` is written (`row`, `data`, `query`, `params`,
`values`, `result`, `input`), each typed as that place types it: a misspelt
member is `CEL_UNKNOWN_FIELD`. A root the place does not bind is
`CEL_UNKNOWN_IDENTIFIER`, naming the resource holding the `to`:

```text
'row' is not available here — Ui.Page/homePage withholds it: a destination reads only the roots bound where it is written
```

`Ui.Destination` declares the roots once, at its schema's root, and a kind
extending it without `base:` — `Ui.Navigate`, `Ui.OpenPage`, a destination kind
of your own — inherits them and declares none. A kind extending one with
`base:` has a schema of its own, and declares them again if its fields read any.

## A link, or a pressed region

A site drawing one text — a link, a menu item, a value, a column, a related
record's label, an option, a navigation entry — takes `to` directly and is
named by that text. A region holding several things — a `box`, `stack` or
`columns` node, a listing's record — takes `press`, which holds the `to` and
the `label` naming the press. A pressed `badge`, `image`, `svg` or `time` is a
`box` with `press` around it, and a pressed text is a `link`.

Running a mutation is never a destination: it stays a
[`button` node](nodes.md#buttons), a row action or another
[call](mutation.md#calls), whose answer and failure are drawn at its button — a
pressed card, a success or a link has no such place.

## Presses

A press is a `Ui.Press`: what pressing a region does, and its accessible name.

| Field | |
| --- | --- |
| `to` | required: where pressing the region goes, a [destination](#destinations) |
| `label` | required: a [`Ui.BoundText`](texts.md#a-text-over-data) naming the press |

A listing's [`create` and `edit`](listing.md#create-and-edit) are presses whose
`label` is optional — they are drawn as buttons named by `ui`'s own texts
`create` and `edit` when it is left out — typed from `Ui.Press` itself.

```yaml
- type: box
  press:
    to: { kind: Ui.OpenPage, page: !ref helpPage, queryParams: { topic: getting-started } }
    label: Getting started
  children:
    - { type: badge, text: New }
    - { type: text, style: heading, text: Getting started }
    - { type: text, text: Five minutes to your first project. }
```

The name belongs to the press, never to what the region draws: nothing is
computed from its content, so a card is announced by its label rather than as
all of its text. Write a label that contains the region's visible text —
`Open {$title}` over a card showing the title — so speech input that names
what it sees finds it. Over a record the label takes the record's values:

```yaml
press:
  to: { kind: Ui.OpenPage, page: !ref postPage, pathParams: { id: !cel "row.id" } }
  label: { text: "Open {$title}", values: { title: !cel "row.title" } }
```

`label`'s values read the roots of the place holding the press — `row` in a
listing's, `data` inside a query node — typed as that place types them, and
`to` the roots bound where it is written, as every destination does. A press
with no `label` is `SCHEMA_VIOLATION`, a misspelt value `CEL_UNKNOWN_FIELD`,
and `press` on a node other than a `box`, `stack` or `columns` is
`SCHEMA_VIOLATION`.

The links, buttons and controls inside a pressed region stay targets of their
own above the press, so a card may hold a link to another place and a row
action beside its press.

## What a renderer receives

A `to` reaches a renderer as a `Ui.DestinationSpec`, tagged on `type`, one
branch per kind; `href` is the address in its wire form, resolved in the
browser.

```json
{ "type": "navigate", "href": { "path": { "value": "/" }, "pathParams": {}, "queryParams": {} } }
```

```json
{
  "type": "openPage",
  "href": { "path": { "value": "/posts/{id}" }, "pathParams": { "id": { "root": "row", "path": ["id"] } }, "queryParams": {} },
  "surface": { "type": "drawer", "side": "end", "size": "medium", "modal": true, "dismiss": { "escape": true, "outside": true, "closeButton": true }, "address": { "name": "post" } },
  "keepsSurface": false
}
```

An `openPage` always carries its `surface` filled — any of the five surface
specs; a dialog's defaults when none was written — and `keepsSurface`, `true` exactly when `surface` was
omitted, so a renderer reads no default of its own. A `Ui.Dialog` written with
no field of its own and an omitted `surface` give equal surfaces on the wire
and different `keepsSurface`.

A press reaches a renderer as a `Ui.PressSpec`, `{ to, label }`: `to` its
destination's spec and `label` the [text](texts.md#what-a-renderer-receives)
as written — a text record, or with its `values` beside it as bindings. A
`box`, `stack` and `columns` node carry it as `press`, and a `listing` node
carries `create`, `edit` and its record `press`; each is `null` when none is
written (a listing's `press` is its `edit` when only that is written), and a
listing's `label` is always filled.

```json
{
  "to": {
    "type": "openPage",
    "href": { "path": { "value": "/posts/{id}" }, "pathParams": { "id": { "root": "row", "path": ["id"] } }, "queryParams": {} },
    "surface": { "type": "drawer", "side": "end", "size": "medium", "modal": true, "dismiss": { "escape": true, "outside": true, "closeButton": true }, "address": { "name": "post" } },
    "keepsSurface": false
  },
  "label": {
    "text": { "text": "Open {$title}", "context": null, "lang": "en", "computed": false },
    "values": { "title": { "root": "row", "path": ["title"] } }
  }
}
```
