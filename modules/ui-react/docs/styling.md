# The styling contract

Everything the renderer draws is an element carrying `data-telo-part`, and
state is carried in `data-` attributes. The lists below are closed and are the
contract: a stylesheet written against them keeps working across releases.

Dialogs, choice lists, checkboxes and tooltips are Radix primitives, and icons
are Lucide's. A dialog, a choice list and a tooltip are drawn at the end of
`<body>`, outside the `app` part, so select them by their own part and never as
a descendant of `app`, `table` or `form`.

```css
[data-telo-part="table-row"][data-style~="muted"] { opacity: 0.6; }
[data-telo-part="nav-link"][data-current="page"] { font-weight: 700; }
```

## Layers

| Order | Layer | Holds |
| --- | --- | --- |
| 1 | `telo.base` | the renderer's layout — display, flex, where a dialog and a choice list sit |
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
  dialogs and choice lists.
- `color.text` is text; `color.muted` secondary text, placeholders and quiet
  icons.
- `color.border` is every border and divider.
- `color.accent` is the primary buttons, a checked checkbox and links, and
  `color.accent-text` what is written on them.
- `color.danger` is invalid fields, error nodes and the destructive button.
- `radius.sm` rounds list entries and tooltips; `radius.md` buttons, inputs,
  the table frame and choice lists; `radius.lg` dialogs.
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
| `table-frame` | the bordered box the grid scrolls in |
| `table-grid` | the `table` element |
| `table-head` | the header section |
| `table-body` | the body section |
| `table-row` | one row |
| `table-header-cell` | one header cell |
| `table-sort` | the button sorting by a column |
| `table-cell` | one cell |
| `row-actions` | the cell holding a row's buttons |
| `row-edit` | a row's edit button, an icon |
| `row-delete` | a row's delete button, an icon |
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
| `field-error` | what is wrong with a field |
| `form-error` | what is wrong that no field names |
| `form-actions` | the row of buttons under a form or in a confirmation |
| `submit` | the button that commits |
| `cancel` | the button that backs out |

### Filters

| Part | Is |
| --- | --- |
| `filters` | a filter bar and what it filters |
| `filter` | one filter: label and control |
| `filter-label` | a filter's label |
| `filter-input` | a filter typed into |
| `filter-select` | a filter chosen from a list: the button showing what is chosen |
| `filters-reset` | the button clearing every filter |

### Dialog

| Part | Is |
| --- | --- |
| `dialog-overlay` | what covers the page behind a dialog |
| `dialog` | a modal panel |
| `dialog-header` | its title and description |
| `dialog-title` | its title |
| `dialog-description` | what a confirmation says under its title |
| `dialog-close` | the button closing a form's dialog, an icon |

A form's `form-actions` inside a dialog, and a confirmation's, is the dialog's
footer.

### Shared

| Part | Is |
| --- | --- |
| `icon` | every icon: in a button, a choice control, a list entry, an error or loading node |
| `select-content` | the open list of a `select` or a `filter-select` |
| `select-item` | one entry of that list |
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
| `data-state="…"` | `idle`, `loading`, `error`, `empty`, `submitting` | `page`, `table`, `form`, `filters`, `component` |
| `data-invalid="…"` | `true` | `field`, `input`, `textarea`, `select`, `checkbox` |
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
| `open`, `closed` | `dialog`, `dialog-overlay`, `select`, `filter-select`, `select-content` |
| `checked`, `unchecked` | `checkbox`, `select-item` |
| `closed`, `delayed-open`, `instant-open` | `row-edit`, `row-delete`, `pager-prev`, `pager-next`, `tooltip` |

A `select` or `filter-select` with nothing chosen carries `data-placeholder`,
and the `select-item` under the pointer or the keyboard carries
`data-highlighted`.

`data-style` is a space-separated list, so match one name with `~=`. A table
row carries its `rowStyle`, a cell its column's `style`, and the delete
confirmation's `submit` carries `danger`.

A `text` node styled `heading` is an `h2`, and `subheading` an `h3`.
