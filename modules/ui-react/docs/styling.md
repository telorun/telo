# The styling contract

Everything the renderer draws is an element carrying `data-telo-part`, and
state is carried in `data-` attributes. The lists below are closed and are the
contract: a stylesheet written against them keeps working across releases.

Dialogs, drawers, popovers, confirmations, choice lists, menus, checkboxes,
switches, sliders, option groups and tooltips are Radix primitives, and icons
are Lucide's. A dialog, a drawer, a popover, a confirmation, a choice list, a
menu and a tooltip are drawn at the end of `<body>`, outside the `app` part, so
select them by their own part and never as a descendant of `app`, `table`,
`form` or `filters`.

```css
[data-telo-part="table-row"][data-style~="muted"] { opacity: 0.6; }
[data-telo-part="nav-link"][data-current="page"] { font-weight: 700; }
```

## Layers

| Order | Layer | Holds |
| --- | --- | --- |
| 1 | `telo.base` | the renderer's layout — display, flex, where each surface and a choice list sit |
| 2 | `telo.theme` | the default theme (omitted with `defaultTheme: false`), then your `Ui.Theme` tokens as custom properties |
| 3 | `telo.component` | each custom component's stylesheet |
| last | unlayered | the application's `stylesheets` |

Unlayered rules win over every layer whatever their specificity, so your
stylesheet never has to out-specify the renderer's.

## Tokens

A `Ui.Theme` token is a custom property: `color.accent-text` is
`--telo-color-accent-text`. The default theme gives every token a value and
reads them for colours, spacing, radii, shadows and type.

The default theme is neutral: near-black text and primary buttons on white,
hairline borders, 2rem controls. It reads the tokens this way:

- `color.background` is the page; `color.surface` the header, controls,
  surfaces and choice lists.
- `color.text` is text; `color.muted` secondary text, placeholders and quiet
  icons.
- `color.border` is every border and divider.
- `color.accent` is the primary buttons, a checked checkbox and links, and
  `color.accent-text` what is written on them.
- `color.danger` is invalid fields, error nodes and the destructive button.
- `radius.sm` rounds list entries and tooltips; `radius.md` buttons, inputs,
  the table frame, inline surfaces, panels and choice lists; `radius.lg` dialogs,
  popovers and confirmations.
- `font.body`, `font.heading` and `font.mono` are `Geist` and `Geist Mono`
  when the viewer has them, and the system's faces otherwise.

Hover fills, focus rings and tinted backgrounds are mixed from those tokens
(the `--telo-derived-*` properties), so setting a token moves them with it.
The derived properties are the default theme's own and not part of the
contract.

The default theme follows the viewer's system setting: under
`prefers-color-scheme: dark` it gives the colour and shadow tokens dark values
— light text and primary buttons on near-black. A token your `Ui.Theme` sets
applies in both, so a theme that sets a surface or text colour should set the
ones that must contrast with it too — or decline the built-in theme with
`defaultTheme: false` and style both schemes yourself.

## Parts

### Shell

| Part | Is |
| --- | --- |
| `app` | the whole application |
| `header` | the bar holding the title and the navigation |
| `app-title` | the application's title |
| `nav` | the navigation |
| `nav-link` | a link to a page |
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
| `image` | an `image` node |
| `svg` | an `svg` node, drawn as an image |

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

### Action

| Part | Is |
| --- | --- |
| `action` | an action, with everything belonging to it: its form, then what its operation answered |
| `action-result` | the lists drawn from the answer; absent until the operation has answered, and while it runs again |
| `list` | one list of the answer: its heading, then its grid |
| `list-heading` | a list's heading, an `h3`; absent when the list declares none |

Inside `action`, in this order: one `form` holding a `field` per field, a
`form-error` when there is one, and a `form-actions` with the `submit`; an
`error` when the operation failed; `action-result`. The `form` of an action
carries no `data-state` and no `data-dirty` — the `action` carries the state.

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
| `filter-chip` | under `controls: chips`, the button naming a property's filters and what they hold, which opens them |
| `filter-input` | a filter typed into, and the box tags are typed into |
| `filter-select` | a filter chosen from a list: the button showing what is chosen |
| `filter-options` | a filter's values side by side, under `control: options` |
| `filter-option` | one of them |
| `filter-toggle` | a switch, under `control: toggle` |
| `filter-slider` | a slider, under `control: slider` |
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

A switch's thumb and a slider's inside carry no part. The thumb of
`filter-toggle` is its `::before`. In `filter-slider` the track is the first
child, the filled range is the track's child, and the thumb is the element with
`role="slider"`.

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
| `data-state="…"` | `idle`, `loading`, `error`, `empty`, `submitting` | `page`, `table`, `form`, `filters`, `component`, `action`, `row-action` |
| `data-invalid="…"` | `true` | `field`, `input`, `textarea`, `select`, `checkbox`, `options`, `tags` |
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

The primitives set `data-state` too, with values of their own, on the parts
they draw. The attribute is the same; the part says whose value it holds, so
always select a state together with its part — `[data-state="error"]` alone
is safe, `[data-state="closed"]` alone matches a closed choice control and an
idle tooltip trigger alike.

| Values | On |
| --- | --- |
| `open`, `closed` | `surface`, `surface-overlay`, `select`, `filter-select`, `select-content`, `filters-bar`, `filter-chip`, `menu` |
| `on`, `off` | `filters-preset`, `filter-option`, `option` |
| `checked`, `unchecked` | `checkbox`, `select-item`, `filter-toggle` |
| `closed`, `delayed-open`, `instant-open` | `row-edit`, `row-delete`, `pager-prev`, `pager-next`, `tooltip` |

A `select` or `filter-select` with nothing chosen carries `data-placeholder`,
and the `select-item` or `menu-item` under the pointer or the keyboard carries
`data-highlighted`. `filters-bar` carries `open` / `closed` only in a
collapsible bar, and `filters-add` carries no state: its list's is on `menu`.

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
