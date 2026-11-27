# Surfaces

A surface is where an opened page appears, and how it is dismissed. Whoever
opens the page names it — a [`Ui.OpenPage`](presses.md#uiopenpage) takes one,
wherever it is written: a listing's `create` and `edit`, a `button`, a link, an
call's success — and the page says nothing about it, so one page can open in
a dialog from one listing and in a panel from another.

Each way of appearing is a kind. `kind:` is the only thing that tells them
apart, and each kind takes only the keys that mean something for it: a key a
kind does not take is `SCHEMA_VIOLATION` on that resource.

| Kind | Is |
| --- | --- |
| [`Ui.Dialog`](#uidialog) | a centred window over the page |
| [`Ui.Drawer`](#uidrawer) | a sheet sliding in from an edge of the viewport |
| [`Ui.Popover`](#uipopover) | a card anchored to the control that opened it |
| [`Ui.InlineSurface`](#uiinlinesurface) | in line with the content |
| [`Ui.Panel`](#uipanel) | a panel beside the composite holding what was pressed |

```yaml
kind: Ui.Listing
metadata: { name: todos }
model: !ref Todo
presentation: !ref todosPresentation
create:
  to: { kind: Ui.OpenPage, page: !ref newTodoPage, surface: { kind: Ui.Dialog, size: small } }
edit:
  to:
    kind: Ui.OpenPage
    page: !ref todoPage
    pathParams: { id: !cel "row.id" }
    surface:
      kind: Ui.Panel
      address: { name: todo }
      compact: { kind: Ui.Drawer, side: bottom }
```

A surface is written in place, as above, or declared once and named with
`!ref` wherever it is used. To go to a page in place of the current one, use a
[`Ui.Navigate`](presses.md#uinavigate); to keep the list beneath, a `Ui.Dialog`
with `size: full`.

## The abstracts

- **`Ui.Surface`** — any surface. A slot that takes a surface, such as a
  `Ui.OpenPage.surface`, is typed by it, so it accepts all five kinds and a
  kind of your own that extends it. It provides a `Ui.SurfaceSpec`.
- **`Ui.Overlay`** — a surface floating over the page: `Ui.Dialog`,
  `Ui.Drawer` and `Ui.Popover` extend it, and it extends `Ui.Surface`. A slot
  typed by it takes only those. It provides a `Ui.OverlaySpec`.
- **`Ui.ViewportOverlay`** — an overlay placed against the viewport rather
  than against what opened it: `Ui.Dialog` and `Ui.Drawer` extend it, and it
  extends `Ui.Overlay`. Every `compact` slot is typed by it, so a kind of your
  own that extends it is accepted there with no change to `ui`; it provides a
  `dialog` or `drawer` spec.

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

This is the surface a `Ui.OpenPage` uses when it names none outside an opened
page: its defaults are those of `surface: { kind: Ui.Dialog }`, but
[an omitted surface](#a-page-opened-in-a-surface) keeps the one it is pressed
in, which a written dialog does not.

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

The page is drawn in line after what was pressed: under the record in a
listing, after the node elsewhere. It has no address.

## Ui.Panel

| Field | | |
| --- | --- | --- |
| `side` | `end` | the edge it sits at: `start` or `end` |
| `size` | `medium` | `small`, `medium` or `large` |
| `dismiss.escape` | `true` | the Escape key closes it |
| `dismiss.closeButton` | `true` | it shows a close button |
| `address` | | [`{ name }`](#address) |
| `compact` | | [the surface used on a narrow viewport](#compact) |

It is drawn beside the nearest composite holding what was pressed — a
listing, a form, a split view — which stays visible and usable: another row can
be opened while one is.

## Address

`address: { name }` makes what is open part of the page's address, so an open
page can be linked to, reloaded, and left with the browser's back button.
`name` is letters and digits, starting with a letter. The value under that name
is always the opened page's app-relative address — `/tasks/7`,
`/tasks/new` — and nothing else, so what is open is the page that address names.

- **Give the surfaces of one listing's `create` and `edit` the same name** to
  let one open page replace the other.
- Opening adds a history entry, and closing goes back to the one before. An
  address opened cold — from a link, or after a reload — closes in the same
  entry, since there is none of this visit's to go back to.

How a renderer spells the address is its own: see the renderer's
documentation.

## A page opened in a surface

A [`Ui.OpenPage`](presses.md#uiopenpage) opens a page of the application over
the current one, in any surface. What is drawn is the page's own content, the
one a navigation to its address shows, titled by the page's `title`, else by
the text naming what opened it. A page no application lists draws the not-found
page in the surface, as a link to it would.

```yaml
- type: link
  text: Ada
  to:
    kind: Ui.OpenPage
    page: !ref authorPage
    pathParams: { id: ada }
    surface: { kind: Ui.Drawer, side: end, address: { name: author } }
```

**Placement against what opened it.**

- A `Ui.Popover` is anchored to the pressed element.
- A `Ui.InlineSurface` is drawn in line after it: under the record in a
  listing, after the node elsewhere.
- A `Ui.Panel` is drawn beside the nearest composite holding the pressed
  element.
- A `Ui.Dialog` and a `Ui.Drawer` are placed against the viewport.

**A cold load.** The declaration the address lookup finds — the route's page
document, then its layout, in tree order, the first equal surface — stands in
for what opened the page, and the surface is placed where its own rule puts it
relative to that declaration, whenever that place is one element known from the
documents alone:

- a panel is beside the nearest composite holding the declaring node, known
  whenever that composite is outside every region that binds `row` — so a
  reloaded master-detail panel sits beside its listing;
- a popover or an inline surface is at the declaring node itself, known only
  where that node is the pressed element (a `link` or `button` node, a pressed
  `box`, `stack` or `columns`) outside every region binding `row`.

A listing's `create`, `edit` and `press`, and every per-record opener, have no
such place. Where the place is not on screen — a notification, a listing's
opener on a cold load, a trigger since redrawn, an anchor not mounted when the
page is first drawn (pending `query` content, a `shown` not holding, an
unchosen tab) — and on a narrow viewport, the surface's `compact` is used, else
a dialog. Placement is decided when the page is opened, with no wait for any
read; afterwards only the breakpoint changes it.

- **One opened page at a time.** Opening a page while one is open replaces
  it and takes its history entry, so Back never walks a chain of opened pages.
- **A page opened in a panel or an inline surface is a context of its own,
  exactly as one in a drawer is:** its own presses replace its content, and its
  own address parameters stay in memory.
- **An omitted `surface` keeps the one it is pressed in.** Inside an opened
  page it is that page's surface — its kind, its address name and its
  `compact` — and only the content changes; anywhere else it is a dialog with
  its defaults. A written `surface` is always honoured.
- **A written surface equal to the open one swaps the content.** Inside an
  opened page, or on the page under a non-modal one, a destination whose
  surface equals the open one — every member, defaults filled — keeps it open
  and changes only its content (two records of one listing opening in one
  drawer); any other closes it and opens its own.
- **A non-modal surface** (`modal: false`) leaves the page under it usable, so
  a link there opens its page in the same surface by the rule above.
- **Going elsewhere closes it.** A `Ui.Navigate` inside an opened page moves
  the application, which closes the page. Escape and the close button shut it
  and return focus to what opened it.
- With `address: { name }` the opened page is part of the host page's address,
  so it reopens on reload and the back button closes it; without one it is held
  in memory. What the opened page's own nodes keep in an address — a filter
  bar's values — is held in memory, so only the opened page's address enters
  the host's. How a renderer spells it is its own.

## Compact

`compact` names the surface used instead when the viewport is narrower than
the application's breakpoint — a panel beside a list has no room on a phone,
and a popover no control to sit beside. It takes a `Ui.ViewportOverlay` — a
`Ui.Dialog`, a `Ui.Drawer` or a kind of your own extending it — by `!ref` or
in place. A surface open when the viewport crosses
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

A [`Ui.Aside`](split-view.md#the-aside) — a split view's or a page layout's —
names a compact surface the same way, at `aside.compact`; it has no address of
its own to stand in for, so the same two rules apply to it.

## Closing from an effect

A [`Ui.Close`](toasts.md#uiclose) in an `onSuccess` or `onFailure` list closes
the surface the call ran in, once the effects before it have happened, if that
surface is still open — so an Archive pressed in a drawer closes the drawer and
then says so in a [toast](toasts.md). It is an effect and not a destination: it
has no address, so a link to it is `REFERENCE_KIND_MISMATCH`.

## After a submit, and unsaved input

Both belong to the form the opened page holds — a [`Ui.Form`](form.md#the-form-owns-its-lifecycle)
says `afterSubmit` and `unsaved` itself — so a form reached by its own address
behaves as one opened in a surface: `afterSubmit: close` closes the surface the
form's page is open in, and on a page of its own the form stays, saved.

**What `unsaved: confirm` asks about.** A form holds unsaved input from the
first change until it is saved. A form with an [`autosave`](form.md#unsaved)
is also unsaved while its record differs from the one last acknowledged, or a
write is waiting, in flight or failed. While it does, anything that would **close the
form** asks first, and happens only if the user chooses to leave:

- closing the surface the page is open in — its close button, Escape, a click
  outside, Cancel;
- moving to another page;
- another record opening in the same surface.

A move within the page that keeps the form open — a filter in the query, a
fragment — asks nothing. Several forms holding unsaved input are one question.
The guard holds for every form with unsaved input, wherever it is placed.

With an `autosave`, the question's two answers differ in what they do to the
waiting write: **keep editing** leaves it to send as scheduled, **discard** drops
it; a write already in flight is never aborted, and nothing is sent with
`keepalive`, so a stuck server never blocks navigation.

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
`popover`, `inline`, `panel` — with **every member that kind has**,
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
