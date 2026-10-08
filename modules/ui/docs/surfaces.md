# Surfaces

A surface is where a form appears when it is opened, and how it is dismissed.
Whoever opens the form names it — a table's `create` and `edit` each take one
— and the form itself says nothing about it, so one form can open in a dialog
from one table and in a panel from another.

Each way of appearing is a kind. `kind:` is the only thing that tells them
apart, and each kind takes only the keys that mean something for it: a key a
kind does not take is `SCHEMA_VIOLATION` on that resource.

| Kind | Is |
| --- | --- |
| [`Ui.Dialog`](#uidialog) | a centred window over the page |
| [`Ui.Drawer`](#uidrawer) | a sheet sliding in from an edge of the viewport |
| [`Ui.Popover`](#uipopover) | a card anchored to the control that opened it |
| [`Ui.InlineSurface`](#uiinlinesurface) | in line with the content |
| [`Ui.Panel`](#uipanel) | a panel beside the list |
| [`Ui.PageSurface`](#uipagesurface) | in place of the page's content |

```yaml
kind: Ui.Table
metadata: { name: todos }
model: !ref Todo
collection: !ref todoCollection
source: { basePath: /api/todos }
create:
  form: !ref todoForm
  surface: { kind: Ui.Dialog, size: small }
edit:
  form: !ref todoForm
  surface:
    kind: Ui.Panel
    address: { name: todo }
    compact: { kind: Ui.Drawer, side: bottom }
```

A surface is written in place, as above, or declared once and named with
`!ref` wherever it is used.

## The two abstracts

- **`Ui.Surface`** — any surface. A slot that takes a surface, such as a
  table's `create.surface`, is typed by it, so it accepts all six kinds and a
  kind of your own that extends it. It provides a `Ui.SurfaceSpec`.
- **`Ui.Overlay`** — a surface floating over the page: `Ui.Dialog`,
  `Ui.Drawer` and `Ui.Popover` extend it, and it extends `Ui.Surface`. A slot
  typed by it takes only those. It provides a `Ui.OverlaySpec`.

A kind at a slot that does not take it is `REFERENCE_KIND_MISMATCH` on the line
that names it.

## Ui.Dialog

| Field | | |
| --- | --- | --- |
| `size` | `medium` | `small`, `medium`, `large` or `full` |
| `modal` | `true` | whether the page behind it is blocked while it is open |
| `dismiss.escape` | `true` | the Escape key closes it |
| `dismiss.outside` | `true` | a click outside it closes it |
| `dismiss.closeButton` | `true` | it shows a close button |
| `address` | | [`{ name }`](#address) |
| `compact` | | [the surface used on a narrow viewport](#compact) |

This is the surface a table uses when an opener names none: leaving `surface`
out and writing `surface: { kind: Ui.Dialog }` are the same thing.

## Ui.Drawer

| Field | | |
| --- | --- | --- |
| `side` | `end` | the edge it slides in from: `start`, `end`, `top` or `bottom` |
| `size` | `medium` | `small`, `medium`, `large` or `full` |
| `modal` | `true` | as a dialog's |
| `dismiss.escape`, `dismiss.outside`, `dismiss.closeButton` | `true` | as a dialog's |
| `address` | | [`{ name }`](#address) |
| `compact` | | [the surface used on a narrow viewport](#compact) |

`start` and `end` follow the reading direction: `end` is the right edge where
text runs left to right.

## Ui.Popover

| Field | | |
| --- | --- | --- |
| `side` | `bottom` | the side of the control it opens on: `top`, `bottom`, `start` or `end` |
| `align` | `start` | how it lines up with the control along that side: `start`, `center` or `end` |
| `dismiss.escape` | `true` | the Escape key closes it |
| `dismiss.outside` | `true` | a click outside it closes it |
| `compact` | | [the surface used on a narrow viewport](#compact) |

A popover has no address: it is anchored to the control that was pressed, and
an address opened cold has none.

## Ui.InlineSurface

| Field | | |
| --- | --- | --- |
| `compact` | | [the surface used on a narrow viewport](#compact) |

In a table, the create form is drawn above the grid and the edit form under
the row it changes. It has no address.

## Ui.Panel

| Field | | |
| --- | --- | --- |
| `side` | `end` | the edge of the list it sits at: `start` or `end` |
| `size` | `medium` | `small`, `medium` or `large` |
| `dismiss.escape` | `true` | the Escape key closes it |
| `dismiss.closeButton` | `true` | it shows a close button |
| `address` | | [`{ name }`](#address) |
| `compact` | | [the surface used on a narrow viewport](#compact) |

The list stays visible and usable beside it: another row can be opened while
one is.

## Ui.PageSurface

| Field | | |
| --- | --- | --- |
| `address` | required | [`{ name }`](#address) |

The form replaces the page's content, and the content returns when the form
closes. It always has an address, since it is a place of its own.

## Address

`address: { name }` makes what is open part of the page's address, so an open
form can be linked to, reloaded, and left with the browser's back button.
`name` is letters and digits, starting with a letter.

- **Give a table's `create` and `edit` the same name.** That is the intended
  spelling: under one name, the address says either "a new record" or "the
  record with this key", and opening one closes the other.
- **An empty value means a new record.** So under a name only an `edit` opener
  declares, an address with an empty value opens nothing.
- **A row whose key is the empty string cannot be addressed.** Its edit form
  opens all the same, held in memory: nothing is written to the address, no
  history entry is added, and it is never taken for the create form.
- Opening adds a history entry, and closing goes back to the one before. An
  address opened cold — from a link, or after a reload — closes in the same
  entry, since there is none of this visit's to go back to. An edit opened
  from an address reads its record by the key.

How a renderer spells the address is its own: see the renderer's
documentation.

## Compact

`compact` names the surface used instead when the viewport is narrower than
the application's breakpoint — a panel beside a list has no room on a phone,
and a popover no control to sit beside. It takes a `Ui.Dialog` or a
`Ui.Drawer`, by `!ref` or in place. A surface open when the viewport crosses
the breakpoint is swapped in place: what was entered stays.

The opening keeps the address of the surface that declares `compact`, so a
link works at any width. A compact surface therefore declares no address, and
there is one level only:

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_SURFACE_COMPACT_ADDRESSED` | the surface named at `compact` declares `address` |
| `UI_SURFACE_COMPACT_NESTED` | the surface named at `compact` declares `compact` |

The surface declaring `compact` refuses the same things itself when it is
first read (`ERR_UI_SURFACE_COMPACT_ADDRESSED`,
`ERR_UI_SURFACE_COMPACT_NESTED`), for a manifest that never passed
`telo check`.

## After a submit, and unsaved input

Both belong to the opener, beside `surface`:

| Field | | |
| --- | --- | --- |
| `afterSubmit` | `close` | `close` the surface; `keep` it open with its values; on `create` also `again` — keep it open, emptied, for another record |
| `unsaved` | `confirm` | `confirm` asks before unsaved input is dropped; `discard` drops it |

The list reloads after every submit. `again` on `edit` is refused: an edit has
no other record to go on to.

**What `unsaved: confirm` asks about.** A form holds unsaved input from the
first change until it is saved. While it does, anything that would **close the
form** asks first, and happens only if the user chooses to leave:

- closing the surface — its close button, Escape, a click outside, Cancel;
- moving to another page;
- for an addressed surface, moving to an address of the same page that no
  longer names this form — the key gone, or naming another record.

A move within the page that keeps the form open — a filter in the query, a
fragment — asks nothing. Several forms holding unsaved input are one question.

**Back and forward.** A step through the browser's history that would close
the form is undone before the question is asked: the address and the history
are as they were, the form still holds its input, and the entries ahead are
still there. Leaving replays the step the user took; staying leaves everything
as it was.

**Leaving the document.** Closing the tab, reloading, or following a link out
of the application raises the browser's own prompt, while some form holds
unsaved input and only then.

## What a renderer receives

A surface provides a `Ui.SurfaceSpec`: its kind as `type` — `dialog`, `drawer`,
`popover`, `inline`, `panel`, `page` — with **every member that kind has**,
declared or defaulted, plus `address` and `compact` when declared. A renderer
reads no default of its own. `compact` is a `dialog` or `drawer` spec with
neither `address` nor `compact`.

```json
{
  "type": "panel",
  "side": "end",
  "size": "medium",
  "dismiss": { "escape": true, "closeButton": true },
  "address": { "name": "todo" },
  "compact": {
    "type": "drawer",
    "side": "bottom",
    "size": "medium",
    "modal": true,
    "dismiss": { "escape": true, "outside": true, "closeButton": true }
  }
}
```

A kind of your own that extends `Ui.Surface` or `Ui.Overlay` provides one of
these, and a value that is not one is refused when it is provided
(`ERR_OUTPUT_INVALID`).
