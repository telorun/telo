# Ui.SplitView

A fold-out side panel: an `aside` tree beside a `content` tree. A list of
conversations beside a chat, a tree of sections beside a page, a set of filters
beside the results all compose from ordinary `ui` — the split view only places
them. It is a [composite](composite.md), so it is placed with
`{ type: composite, ref: … }` and each tree may hold composites of its own,
which declare their own roots.

```yaml
- type: composite
  ref:
    kind: Ui.SplitView
    label: Conversations
    size: small
    collapse:
      state: { key: conversations, store: { kind: Ui.LocalStore } }
    aside:
      actions:
        - type: link
          text: New conversation
          href: { path: !ref assistant }
          button: { kind: Ui.IconButton, label: shown, icon: { kind: UiLucide.Icon, name: square-pen } }
      content:
        type: composite
        ref: { kind: Ui.Listing, … }
    content:
      type: composite
      ref: { kind: Ui.Chat, … }
```

| Key | | |
| --- | --- | --- |
| `side` | `start` | `start` or `end`: the edge of the content the aside sits at |
| `size` | `medium` | `small`, `medium` or `large`: how wide the aside is, the same three widths [`Ui.Panel`](surfaces.md#uipanel) has |
| `frame` | `flush` | `flush` or `framed`: how the aside is set against the content, [below](#frame) |
| `toggle` | a glyph of the look's own | a [`Ui.ButtonDisplay`](chat.md#buttons-as-icons) drawing the button that folds the aside away and shows it again, [below](#the-toggle) |
| `label` | required | a [text](texts.md) with no values: names the aside for assistive technology and is the value of the button showing and hiding it |
| `aside` | required | `{ actions?, content }`: the panel's [actions](#the-actions), drawn under its top bar, and the [`Ui.Node`](nodes.md) tree it holds, with no roots of its own |
| `content` | required | a `Ui.Node` tree with no roots of its own |
| `collapse` | none | lets the viewer fold the aside away; omitted, it never folds on a wide viewport |
| `compact` | a `Ui.Drawer` from `side` | a `Ui.ViewportOverlay` the aside becomes below the application's breakpoint |

Neither tree reads a root: a `value` or `list` node needs one, so put such
nodes in a composite that declares it (`Ui.Data`, `Ui.Listing`).

## Frame

`flush` (the default) makes the split view one panel: a single border and radius
round both halves, the aside set against the content with no gap, separated by
one divider line on the aside's inner edge, tinted only faintly from the content's
surface and running the content's full height. What the content or the open aside
holds directly — a chat, a listing's list or table — draws no frame of its own
inside it, and the aside's top bar (the toggle's row) is as high as a chat's
header so their bottom lines run across. `framed` draws the aside as a bordered, rounded panel on
the surface background, spaced from the content by the gap. `side: end` mirrors
both: the divider is on the aside's start edge. `frame` governs the aside only
while it is drawn beside the content; in the compact surface the aside takes the
surface's look. The same two values are on [`Ui.ListLayout`](listing-layouts.md#uilistlayout)
(there `framed` is the default), so a split's aside and the list in it can be
made to read as one flush column.

## The toggle

`toggle` is any `Ui.ButtonDisplay`. Left out, the button is an icon button with
the look's own glyph and a hidden label: the open aside draws `panel-close`, a
folded or compact one `panel-open`, and `splitHide` / `splitShow` are its
accessible name and tooltip. `Ui.TextButton` gives a text button of those words;
`Ui.IconButton` with `label: shown` puts the text beside the glyph, and an
`icon` of your own is one glyph drawn for both states. `aria-expanded` is set
whichever way it is drawn. A look mirrors its built-in panel glyphs when exactly
one of these holds: the aside is at the `end`, the page is right-to-left; an
icon of your own is never mirrored.

## The actions

The aside's top bar holds the toggle alone, drawn when the split can fold, and is
the same open, folded and in the rail, so the toggle never moves.

`aside.actions` is a list of button-shaped entries drawn under the bar, before
`aside.content`, for what acts on the aside as a whole: a "New conversation"
button. Each entry is a `link` node with a `button:` (a `Ui.ButtonDisplay`); any
other node, or a link without `button`, is a `SCHEMA_VIOLATION` at `telo check`
and at creation. Omitted, nothing is drawn under the bar. Open beside the
content, the actions are a wrapping row, each entry drawn as its display says.
Folded beside the content, and below the breakpoint (where the rail stays
beside the content and the drawer holds `aside.content` only), they are stacked
under the bar, each a glyph alone with its text as accessible name and tooltip.
An entry whose display is `Ui.TextButton` draws the look's `go` glyph in the
rail. Entries are links like any other, so the one for the current address is
`aria-current="page"`. The former key `aside.bar` is refused.

## Collapsing

`collapse` gives the viewer a button folding the aside away and back:

| Key | Default | |
| --- | --- | --- |
| `collapsed` | `false` | whether the aside starts folded. A stored choice overrides it |
| `state` | none | `{ key, store }`: keeps the choice between visits under `key` — a letter, then letters and digits — in a [`Ui.LocalStore` or `Ui.SessionStore`](state-store.md#stores). Omitted, the choice lasts until the page is closed |

A viewer folding the aside beside the content leaves a narrow rail: the aside's
top bar with the toggle, at the same place and height and with the same divider as open,
and the actions stacked under it as glyphs, and nothing else of the aside; the content only widens. Below the breakpoint the
same rail stays beside the content, and its toggle opens the compact surface
instead of unfolding the aside; no toggle sits in the content.

Two split views naming one `key` and store share the choice. The entry is
`{ "v": 1, "collapsed": <bool> }` under `telo.ui:<mount>:s:<key>`, written on
each change ([how a renderer spells it](../../ui-react/docs/urls.md#split-view-state)).

## The aside never unmounts

The aside stays mounted in every state — open, folded to a rail, or in the compact
surface, a closed drawer included — so what it holds keeps its state: a
listing on page 2 is on page 2 after the viewport crosses the breakpoint and
after the aside is folded and opened. While it is not visible it starts no
request, as for any content a `shown` condition hides, and a change that
arrives meanwhile (a write announced to the path it reads) makes it read once
when it is shown again.

## On a narrow viewport

Below the application's `compactBelow` the aside leaves the page and is opened
by the button, in the `compact` surface. It is a `Ui.ViewportOverlay`
([`Ui.Dialog` or `Ui.Drawer`](surfaces.md)), by default
`{ kind: Ui.Drawer, side: <side> }`. As on every other compact surface it
declares neither an `address` (`UI_SURFACE_COMPACT_ADDRESSED`) nor a `compact`
of its own (`UI_SURFACE_COMPACT_NESTED`): `telo check` reports both, and
`ERR_UI_SURFACE_COMPACT_ADDRESSED` / `ERR_UI_SURFACE_COMPACT_NESTED` are raised
when the split view is first read. A move within the application that
starts from inside the surface — a followed link — closes it.

## What a renderer receives

```json
{
  "type": "split",
  "side": "start",
  "size": "medium",
  "frame": "flush",
  "toggle": { "type": "icon", "icon": null, "label": "hidden" },
  "label": { "text": "Conversations", "context": null, "lang": "en", "computed": false },
  "aside": { "actions": [], "content": { "type": "stack", "children": [] } },
  "content": { "type": "stack", "children": [] },
  "collapse": { "collapsed": false, "state": { "key": "conversations", "store": { "type": "local" } } },
  "compact": { "type": "drawer", "side": "start", "size": "medium", "modal": true, "dismiss": { "escape": true, "outside": true, "closeButton": true } },
  "style": "…",
  "shown": { "…": "…" }
}
```

Every member is present except `style` and `shown` (`aside.actions` is a list of `link` nodes, `[]` for none); `toggle` is a button display
as the [chat's buttons](chat.md#buttons-as-icons) are; `collapse` is `null` when
the aside never folds and `state` is `null` when the choice is not kept. A
tree that resolves to nothing — a `when` that is false — arrives as an empty
`stack`. The keyed texts `splitShow` and `splitHide` (value `label`) are
`ui`'s own, [translated](texts.md#uis-own-texts) into every language it ships.
