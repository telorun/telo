# The styling contract

Everything the renderer draws is an element carrying `data-telo-part`, and
state is carried in `data-` attributes. The lists below are closed and are the
contract: a stylesheet written against them keeps working across releases.

Every text box, choice, list, overlay, menu, tooltip and glyph is drawn by a
control — the built-in one, or a theme's that replaces it — under the
[controls contract](controls-abi.md), which lists the parts and states each
control draws. The built-ins are drawn on the DOM itself, each in its role's
WAI-ARIA pattern, with Lucide's icons; the renderer carries no primitive
library. A dialog, a drawer, a popover, a confirmation, a choice list, a menu
and a tooltip are drawn at the end of `<body>`, outside the `app` part, each
in a layer whose root carries `data-telo-layer`, so select them by their own
part and never as a descendant of `app`, `table`, `form` or `filters`. A
built-in's mechanics place its list or its popover through custom properties
of its own (`--ui-react-control-anchor-width`,
`--ui-react-control-available-height`, `--ui-react-control-origin`), set on
the layer as it is placed; they are no part of this contract, and a theme
reads none of them. `--telo-` custom properties are the design tokens'; a
control's or a theme's own properties use another prefix.

```css
[data-telo-part="table-row"][data-style~="muted"] { opacity: 0.6; }
[data-telo-part="nav-link"][data-current="page"] { font-weight: 700; }
```

## Layers

| Order | Layer | Holds |
| --- | --- | --- |
| 1 | `telo.base` | the layout of the renderer's own composition: the shell, structure nodes, table and list grids, panel and aside placement, field arrangement, filter placements, in-flow surfaces, hiding by state, a surface body's scroll with its actions sticky |
| 2 | `telo.control` | each control's own mechanics — a choice list's stacking, a slider's track, where a dialog or a drawer sits — one stylesheet per built-in control in use, and the stylesheet of each [control set](theme.md#control-sets) the theme lists in place of the built-ins it replaces |
| 3 | `telo.theme` | the [theme](theme.md)'s `tokens` as custom properties, then its `stylesheets` in order, then the application's chosen `tokens` |
| 4 | `telo.component` | each custom component's stylesheet |
| last | unlayered | the application's `stylesheets` |

Unlayered rules win over every layer whatever their specificity, so your
stylesheet never has to out-specify the renderer's. A theme's stylesheet and a
control set's are written as plain CSS: the application places each in its
layer, serving it as written and naming, in the application document, a
stylesheet that imports it into that layer.

## Reserved properties

A property the base layer declares is reserved when documented behaviour
depends on it: a theme does not declare it on that part, or the behaviour
breaks — `UiReact.defaultTheme` declares none.

| Part | Reserved | Because |
| --- | --- | --- |
| `filters-bar` | `display` | a closed collapsible bar is hidden |
| `filters` | `display`, `grid-template-columns` | a bar placed aside sits beside what it filters |
| `surface-body` | `overflow-y`, `min-height` | a surface's body scrolls while its header stays |
| `form-actions` | `position`, `bottom` | a form's actions stay at its surface's bottom edge |
| `table-frame` | `overflow-x` | a grid wider than its table scrolls in its frame |
| `table` | `display`, `grid-template-columns` | a panel sits beside the frame and the pager |
| `table-toolbar` | `order` | the toolbar stays above a panel |
| `surface` | `order` | a panel sits on its side |

## Tokens

A [`Ui.DesignTokens`](../../ui/docs/design-tokens.md) token is a custom
property: `color.accent-text` is `--telo-color-accent-text` (the projection the
code entry `@telorun/ui-react-contract` exports as `tokenProperty`). A theme gives
every token a value — from its own `tokens`, or from its stylesheets — and
reads them for colours, spacing, radii, shadows and type, so an application's
`tokens` change the brand under any theme.

The default theme, [`UiReact.defaultTheme`](theme.md#the-default-theme), is
neutral: near-black text and primary buttons on white, hairline borders, 2rem
controls. It reads the tokens this way:

- `color.background` is the page; `color.surface` the header, controls,
  surfaces and choice lists.
- `color.text` is text; `color.muted` secondary text, placeholders, hints and
  quiet icons.
- `color.border` is every border and divider.
- `color.accent` is the primary buttons, a checked checkbox and links, and
  `color.accent-text` what is written on them.
- `color.danger` is invalid fields, error nodes and the destructive button;
  `color.warning` a field's warning.
- `radius.sm` rounds list entries and tooltips; `radius.md` buttons, inputs,
  the table frame, inline surfaces, panels and choice lists; `radius.lg` dialogs,
  popovers and confirmations.
- `font.body`, `font.heading` and `font.mono` are `Geist` and `Geist Mono`
  when the viewer has them, and the system's faces otherwise.

Hover fills, focus rings and tinted backgrounds are mixed from those tokens
(the `--ui-react-derived-*` properties), so setting a token moves them with it.
The derived properties are the default theme's own and not part of the
contract.

The default theme follows the viewer's system setting: under
`prefers-color-scheme: dark` it gives the colour and shadow tokens dark values
— light text and primary buttons on near-black. A token the application's
`tokens` set applies in both, so a token set that sets a surface or text
colour should set the ones that must contrast with it too — or the
application declares a theme of its own that styles both schemes.

## Parts

### Shell

| Part | Is |
| --- | --- |
| `app` | the whole application |
| `header` | the bar holding the title and the navigation: one row — `header-start`, the title, `nav` taking the room left, `header-end` at its end — while the application is not compact, and wrapping when it is |
| `header-start` | the application's own [header](app.md#header) nodes before the title; drawn only when there are any |
| `app-title` | the application's title |
| `nav` | the navigation; its links wrap within it |
| `nav-link` | a link to a page |
| `header-end` | the application's own header nodes after the navigation; drawn only when there are any |
| `main` | the area below the header |
| `page` | the current page |
| `page-title` | the page's title |

### Structure

| Part | Is |
| --- | --- |
| `box` | a `box` node |
| `stack` | a `stack` node |
| `columns` | a `columns` node |
| `column` | one child of `columns` |
| `text` | a `text` node — `p`, or `h2` / `h3` under `heading` / `subheading` |
| `badge` | a `badge` node |
| `link` | a `link` node |
| `menu-trigger` | a `menu` node: the button opening its links, its text and then an `icon` (`next`, which a theme turns to point down) |
| `image` | an `image` node |
| `svg` | an `svg` node, drawn as an image |
| `value` | a `value` node: one value of a data scope, presented as its schema says — a `format: uri` / `uri-reference` string as a `link` |
| `list` | a `list` node, or one list of an action's answer: its heading, then its grid |
| `list-heading` | a list's heading, an `h3`; absent when the list declares none |
| `data` | a `data` node: a reader, holding its `loading` tree before the first answer, its `content` once one is in, its `failure` when the read did not succeed |

A column of a `list` whose `shown` does not hold is left out, header and cells.

A `menu` node's links are drawn by the `Menu` control: its `menu` and one
`menu-item` per link, the current choice — a link whose style holds `strong` —
marked `data-current="true"` by the built-in and the Radix controls. Its
`style` is on `menu-trigger` as `data-style`.

A `data` part carries `data-state`: `loading` before the first answer, `idle`
once one is drawn, `error` while its `failure` is drawn. A reload keeps the
content mounted; while the failure is drawn the content is kept, out of sight.

A node whose `shown` does not hold is drawn inside an element with
`display: none` — kept mounted, so what it holds survives — and one that holds
inside an element with `display: contents`, which no selector needs to reach.

### Table

| Part | Is |
| --- | --- |
| `table` | a table, with everything belonging to it |
| `table-toolbar` | the row above the grid |
| `table-create` | the button opening the create form |
| `table-main` | the frame and the pager together: what a panel sits beside |
| `table-frame` | the bordered box the grid scrolls in |
| `table-grid` | the `table` element |
| `table-head` | the header section |
| `table-body` | the body section |
| `table-row` | one row |
| `table-header-cell` | one header cell |
| `table-sort` | the button sorting by a column |
| `table-cell` | one cell |
| `row-actions` | the cell holding a row's buttons |
| `row-action` | one operation a row offers, a button showing its label; before edit and delete |
| `row-edit` | a row's edit button, an icon |
| `row-delete` | a row's delete button, an icon |
| `table-detail` | the cell under a row that holds its edit form, opened in line |
| `table-empty` | the cell shown when there are no rows |
| `table-loading` | the cell shown until the first rows arrive |
| `pager` | the paging controls |
| `pager-status` | the range of rows shown and the total |
| `pager-prev` | the previous-page button, an icon |
| `pager-next` | the next-page button, an icon |

### Form

| Part | Is |
| --- | --- |
| `form` | a form |
| `field` | one field: label, control, error |
| `label` | a field's label |
| `input` | a single-line, number or date control |
| `textarea` | a multi-line control |
| `select` | a choice control: the button showing what is chosen, which opens the list |
| `checkbox` | a boolean control, drawn before its label |
| `options` | a list chosen from its listed values, side by side |
| `option` | one of them |
| `tags` | a list typed one item at a time: the items so far and the `input` the next is typed into |
| `tag` | one typed item |
| `tag-remove` | the button in it that removes that item, an icon |
| `field-error` | what is wrong with a field |
| `form-error` | what is wrong that no field names |
| `form-actions` | the row of buttons under a form or in a confirmation |
| `submit` | the button that commits: `Save` on a form, an action's own label on an action, a confirmation's answer |
| `cancel` | the button that backs out |
| `field-group` | a labelled section of a form, around the fields that name it |
| `field-group-label` | the section's heading |
| `field-group-description` | the text under it; absent when the group declares none |
| `field-description` | a field's hint: its model property's `description` |
| `field-warning` | what a field warns of without blocking — a date range longer than its limit |
| `switch` | an on/off control, drawn before its label: an input field's `toggle` |
| `slider` | a number entered by dragging between its `minimum` and `maximum` |
| `slider-value` | the slider's position as text, after its track |
| `options-more` | the button reading more options of a choice drawn side by side, while its source has more |
| `option-hint` | the hint an option source gives beside an option's label |

### Picker

| Part | Is |
| --- | --- |
| `picker` | a picker field's control: the chosen values, then the button choosing them |
| `picker-value` | the chosen values, each its label |
| `picker-chosen` | one chosen value: its label, a `link` where the source gives one |
| `picker-trigger` | the button opening the surface the options are chosen in |
| `picker-search` | the search box in that surface; absent when the source declares no `search` |
| `picker-list` | the options read so far, scrolled for more |
| `picker-empty` | what a picker says when its source offers nothing |
| `picker-option` | one option, `on` while chosen |

### Date range

| Part | Is |
| --- | --- |
| `date-range` | a date range field's control: its presets, then the two dates |
| `date-range-presets` | the presets, side by side; absent when there are none |
| `date-range-preset` | one preset, `on` while the dates equal it |
| `date-range-from` | the date the range starts on |
| `date-range-to` | the date it ends on |

### Action

| Part | Is |
| --- | --- |
| `action` | an action, with everything belonging to it: its form, then what its operation answered |
| `action-result` | the action's `result` tree, drawn from a success; absent until the operation has answered, and while it runs again |
| `action-failure` | the action's `failure` tree, drawn for any answer but a success and for no answer at all |
| `row-answer` | a row action's `result` tree, drawn in the row in place of its `row-action` button once it succeeded |
| `row-failure` | a row action's `failure` tree, drawn in the row beside its button when no confirmation was open |
| `disabled-text` | why a button cannot be pressed — beside an action's `submit` in `form-actions`, or beside a `row-action` — present only while its `enabled` condition does not hold |

Inside `action`, in this order: one `form` holding a `field` per field shown, a
`form-error` when there is one, and a `form-actions` with the `submit` (and the
`disabled-text` while it is disabled); `action-result` after a success, or
`action-failure` after anything else. The `form` of an action carries no
`data-state` and no `data-dirty` — the `action` carries the state, and a
`row-action` its own while its press is pending or queued.

A list's row actions are drawn as a table's are: a last `table-header-cell`
and, per row, a `row-actions` cell holding each `row-action`, or its
`row-answer`.

A `list` draws its rows with the table's own grid parts — `table-frame`,
`table-grid`, `table-head`, `table-body`, `table-row`, `table-header-cell`,
`table-cell`, and `table-empty` when it has no rows — so select a list's grid
as a descendant of `list`, and a table's as a descendant of `table`.

A value the model calls an address (`format: uri` / `uri-reference`) is drawn
in a `table-cell` as a `link`, in a table and in a list alike; one that leads
anywhere but a page of the application carries `target="_blank"`.

A refused list marks its `options` group or its `tags` box, never an `option`,
a `tag` or the `input` inside the box, so one ring is drawn.

### Filters

| Part | Is |
| --- | --- |
| `filters` | a filter bar and what it filters |
| `filters-presets` | the bar's presets: one exclusive choice |
| `filters-preset` | one preset |
| `filters-toggle` | the button unfolding a collapsible bar, or opening a bar drawn in an overlay |
| `filters-count` | in that button, how many filters hold a value; absent when none does |
| `filters-bar` | what holds the controls: the filters, then `filters-add` — and, in a bar that does not fold, `filters-apply` and `filters-reset` |
| `filters-add` | the button listing the filters that are not on show, under `show: chosen` |
| `filters-apply` | the button applying what was entered in the controls, under `apply: button` |
| `filters-reset` | the button returning every filter to its declared default |
| `filters-summary` | the row of chips, under `summary: chips` |
| `summary-chip` | one filter holding a value: its label, its operator and the value |
| `summary-chip-remove` | the button in it that clears that filter, an icon |
| `filters-content` | what the bar filters |
| `filter` | the filters on one property: its label, and one control or a group of them |
| `filter-label` | a property's label |
| `filter-group` | the controls of a property filtered more than one way, side by side |
| `filter-bound` | one of them: its caption and its control |
| `filter-caption` | what tells it from the others: `from`, `to`, `after`, `before`, `is`, `contains`, `one of` |
| `filter-remove` | the button taking a filter off show and clearing it, an icon; never on a pinned filter |
| `filter-chip` | under `controls: chips`, the button naming a property's filters and what they hold, which opens them; its `title` holds the same text whole, for a theme that cuts it short |
| `filter-input` | a filter typed into, and the box tags are typed into |
| `filter-select` | a filter chosen from a list: the button showing what is chosen |
| `filter-options` | a filter's values side by side, under `control: options` |
| `filter-option` | one of them |
| `filter-toggle` | a switch, under `control: toggle` |
| `filter-slider` | a slider, under `control: slider` |
| `filter-slider-value` | its position as text, after its track: what the filter holds, or `Any` while it holds nothing |
| `filter-tags` | the values typed so far and the box the next is typed into, under `control: tags` |
| `filter-tag` | one typed value |
| `filter-tag-remove` | the button in it that removes that value, an icon |

**Changed:** a bar's controls are inside `filters-bar` and what it filters
inside `filters-content`; both were direct children of `filters`. A rule
written as `filters > filter` or `filters > table` selects nothing now.

Where each sits, inside `filters`, in this order: `filters-presets`; the pinned
`filter`s (or `filter-chip`s) of a bar that folds, then its `filters-toggle`,
`filters-apply` and `filters-reset`; `filters-bar`; `filters-summary`;
`filters-content`.

`filters-apply` and `filters-reset` are never inside what folds: in a
collapsible or an overlay bar they are children of `filters`, beside the
toggle, and in a bar that does not fold they are the last children of
`filters-bar`. A folding bar with no filter to fold — none that is both
unpinned and drawn — has no `filters-toggle` and no `filters-bar`.

- `data-placement="above"` and `"aside"`: `filters-bar` is always drawn, and
  holds every filter. Beside the content it sits on the bar's `data-side`.
- `"collapsible"`: `filters-bar` is always in the document and carries
  `data-state="open"` or `"closed"`; the base layer hides it while closed.
- `"overlay"`: `filters-bar` exists only while the overlay is open, inside the
  `surface-body` of a `surface` titled `Filters`, followed by a `form-actions`
  holding one `submit` reading `Done`.

Under `controls: chips` a `filter-chip` stands where the `filter` would, and
the `filter` itself is drawn while the chip is open, inside a `surface` with
`data-surface="popover"` that has no header and no body part.

A switch's thumb and a slider's track and thumb carry no part. In the
built-ins, the thumb of `filter-toggle` and `switch` is its `::before`; in
`filter-slider` and `slider` the track is the first child, the filled range is
the track's child, and the thumb is the element with `role="slider"`. The
slider's last child is its `slider-value` or `filter-slider-value`, which the
control's mechanics place just past the root's inline end, so its width never
moves the track: give the slider a `margin-inline-end` that leaves it room, and
the value a `min-width` and `font-variant-numeric: tabular-nums` so the text
holds still as it changes.

### Surface

Where a form opens, where a filter bar's overlay and a filter chip's control
open, and every confirmation. One family whatever the kind: `data-surface`
says which.

| Part | Is |
| --- | --- |
| `surface-overlay` | what covers the page behind a modal dialog or drawer, and behind a confirmation |
| `surface` | the surface itself: a dialog, a drawer, a popover, an inline form, a panel, a form in place of the page, or a confirmation |
| `surface-header` | its title, and a confirmation's description |
| `surface-title` | its title: `New` or `Edit` for a form, `Filters` for a filter bar's overlay, the question for a confirmation — or the label of a row's operation that was refused without one |
| `surface-description` | what a confirmation says under its title; absent from a row operation's confirmation |
| `surface-body` | what holds the form; it scrolls while the header and the form's actions stay. What it holds is drawn inside two wrapper elements with `display: contents`, so select a form in it as a descendant, not as a child |
| `surface-close` | the button closing a form's surface, an icon |

A form inside a surface fills its `surface-body`, so its `form-actions` stays
at the surface's bottom edge — under a form shorter than the surface, and over
one that scrolls — and a confirmation's is its footer. Cancel is always there, and nothing dismisses a
surface while its form is being sent.

Where each sits:

- `dialog`, `drawer`, `popover` and `confirmation` are at the end of `<body>`.
- `inline` is in the `table`: above `table-main` for the create form, in a
  `table-detail` cell under its row for an edit.
- `panel` is in the `table`, beside `table-main`, on its `data-side`.
- `page` is in the `page`, where its content was; the content is not drawn
  until the surface closes.

### Shared

| Part | Is |
| --- | --- |
| `icon` | every icon: in a button, a choice control, a list entry, an error or loading node |
| `select-content` | the open list of a `select` or a `filter-select` |
| `select-item` | one entry of that list |
| `menu` | an open list of things to do: the filters `filters-add` offers |
| `menu-item` | one entry of it |
| `tooltip` | the name of an icon-only button, shown on hover and focus |

### Status

| Part | Is |
| --- | --- |
| `component` | the wrapper around a custom component |
| `error` | an error node |
| `error-code` | its code |
| `error-message` | its message |
| `loading` | shown while something is being fetched or loaded |

No part is listed that nothing emits, and nothing is emitted that is not
listed.

## State

| Attribute | Values | On |
| --- | --- | --- |
| `data-state="…"` | `idle`, `loading`, `error`, `empty`, `submitting` | `page`, `data`, `table`, `form`, `filters`, `component`, `action`, `row-action` |
| `data-invalid="…"` | `true`, while what it holds is refused; the control inside carries its own | `field`, `picker` |
| `data-dirty="…"` | `true`, while it holds input that is not saved | `form` |
| `data-compact="…"` | `true`, while the viewport is below the application's `compactBelow` | `app` |
| `data-surface="…"` | `dialog`, `drawer`, `popover`, `inline`, `panel`, `page`, `confirmation` | `surface` |
| `data-side="…"` | `start`, `end`, `top`, `bottom`: the edge a drawer or a panel sits at, the side of its control a popover opens on; `start` or `end` for the side of its content a filter bar's controls sit at, under `data-placement="aside"` only | `surface`, `filters` |
| `data-placement="…"` | `above`, `aside`, `collapsible`, `overlay`: where the bar's controls sit now — its compact placement's below the application's `compactBelow` | `filters` |
| `data-active="…"` | `true`, while one of its filters holds a value | `filter`, `filter-chip` |
| `data-pending="…"` | `true`, while what was entered in a control is not yet applied: typed text not committed, a pause under `apply: typing`, a control changed before Apply under `apply: button` | `filters` |
| `data-size="…"` | `small`, `medium`, `large`, `full` — a dialog's, a drawer's or a panel's | `surface` |
| `data-align="…"` | `start`, `center`, `end` — a popover's, along its side | `surface` |
| `data-modal="…"` | `true`, `false` — a dialog's or a drawer's | `surface` |
| `data-sorted="…"` | `asc`, `desc` | `table-header-cell` |
| `data-current="…"` | `page` | `nav-link` |
| `data-style="…"` | the node's or the rule's style names, space-separated | wherever a style applies |

Two parts of the renderer's own carry `data-state` with values of their own,
and every control carries the states the [controls
contract](controls-abi.md#states) lists for it — `open` / `closed` on a list
or an overlay, `on` / `off` on an option, `checked` / `unchecked` on a
checkbox. The attribute is the same; the part says whose value it holds, so
always select a state together with its part — `[data-state="error"]` alone
is safe, `[data-state="closed"]` alone matches a closed choice control and a
folded filter bar alike.

| Values | On |
| --- | --- |
| `open`, `closed` | `filters-bar`, `filter-chip` |

`filters-bar` carries `open` / `closed` only in a collapsible bar, and a
`filter-chip` is `open` while its popover is. The element a control opens
from — `filters-add`, an icon button — carries no state of the control's: its
list's is on `menu`, its tooltip's on `tooltip`.

An `action` is `idle`, `submitting` while its operation runs, and `error` once
its record or the operation was refused. A `row-action` carries `data-state`
only while its own operation runs — `submitting`. A table sends one row write
at a time, so for as long every `row-action` and `row-delete` of that table
is `disabled`, the pressed one alone carrying the state; every `row-action`
is disabled while a row is being deleted, too.

`data-style` is a space-separated list, so match one name with `~=`. A table
row carries its `rowStyle`, a cell its column's `style`, and a confirmation's
`submit` — deleting a row, discarding unsaved input — carries `danger`; the
`submit` of a row operation's confirmation carries none.

A surface carries only the attributes its kind has: `data-side` on a drawer, a
popover and a panel, `data-size` on a dialog, a drawer and a panel,
`data-align` on a popover, `data-modal` on a dialog and a drawer. On `surface`
these hold what the application declared; a tooltip and a choice list carry a
`data-side` and a `data-align` of their own, set by the primitive to where it
placed them.

A `text` node styled `heading` is an `h2`, and `subheading` an `h3`.
