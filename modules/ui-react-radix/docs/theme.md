# The theme and its controls

`ui-react-radix` exports two resources and nothing else: a
[`UiReact.Theme`](../../ui-react/docs/theme.md) named `theme`, and the
[`UiReact.Controls`](../../ui-react/docs/theme.md#control-sets) set named
`controls` that the theme draws with. It imports `ui-react` and `ui`; neither
imports it.

```yaml
imports:
  UiReact: oci://ghcr.io/telorun/ui-react
  Radix: oci://ghcr.io/telorun/ui-react-radix
---
kind: UiReact.App
metadata: { name: console }
theme: !ref Radix.theme
# …
```

## The theme

`Radix.theme` is Studio's look: neutral surfaces, the brand blue as the
accent, outlined and slightly raised fields and buttons, bordered popups, a
quiet header holding the title in the accent colour, and table headings in
small uppercase letters. It holds:

- `tokens` — the design tokens' light values, a `Ui.DesignTokens` set;
- `stylesheets` — one stylesheet, `themes/radix-theme.css`, styling every part
  of [the styling contract](../../ui-react/docs/styling.md), giving the
  typeface tokens and every dark-scheme value, and declaring no reserved
  property;
- `controls` — `Radix.controls`.

An application's own `tokens:` apply after all of it, so its brand wins over
the theme's values in both schemes. The theme's own custom properties are
`--ui-react-radix-*`, derived from the tokens; `--telo-*` are the design
tokens only.

## The controls

`Radix.controls` implements eleven controls of
[`ui_react_controls-1`](../../ui-react/docs/controls-abi.md) in one browser
entry, `@telorun/ui-react-radix`, which leaves only `react`,
`react/jsx-runtime` and `react-dom` to the page:

| Control | Drawn with |
| --- | --- |
| `Select` | Radix's select, placed against its trigger |
| `MultiSelect` | Radix's dropdown menu of checkbox items, open while choices are made |
| `Listbox` | the list a picker shows, one option per entry |
| `Checkbox` | Radix's checkbox |
| `Dialog`, `Drawer` | Radix's dialog; the mechanics place a drawer at its edge |
| `Popover` | Radix's popover, placed against the renderer's anchor |
| `Confirmation` | Radix's alert dialog |
| `Menu` | Radix's dropdown menu, opened from the renderer's button; an entry given `current` is marked `aria-current` and `data-current` |
| `Tooltip` | Radix's tooltip |
| `Icon` | Lucide's glyphs |

Every other control — the text boxes, dates and times, tags, ranges,
switches, sliders and option groups — is the renderer's built-in. The
mechanics the eleven need (where a list or a dialog sits, its stacking and
size) are the stylesheet the entry builds, which the application places in
the `telo.control` layer in place of the built-ins' own.

### One stack of layers

The eight [layer controls](../../ui-react/docs/controls-abi.md#layers) —
`Select`, `MultiSelect`, `Dialog`, `Drawer`, `Popover`, `Confirmation`,
`Menu`, `Tooltip` — are all here, drawn by one copy of the primitives, which
keeps one stack of every layer a page opens:

- Escape closes only the top layer.
- A press outside the top layer reaches each layer from the top down, as far
  as the first that shields what is beneath it: a modal dialog or drawer, a
  confirmation, an open select, multi-select or menu list. A popover, a
  non-modal dialog or drawer and a tooltip do not shield, so a press on the
  page closes a filter chip's popover and the popover holding the chip
  together.
- A press or the focus inside a layer drawn after one is never one outside it.
- The root of every live layer at the end of `<body>` carries
  `data-telo-layer` — the element Radix places a list, a menu, a popover or a
  tooltip in, a dialog's surface and its overlay — and keeps it while a later
  modal layer covers it. The copy left behind for a closing animation carries
  none.
- A modal layer holds the focus inside it and gives it back as it closes.

A layer something else draws — a custom component's own — gets none of the
built-in stack's guarantees under this set: Radix cancels Escape in the
capture phase, and a modal layer traps the focus and stops pointer events on
the rest of the page.

## A theme of your own over these controls

A module wanting its own look with these controls declares a theme that
references the set whole and brings a complete stylesheet of its own:

```yaml
kind: Telo.Library
metadata: { name: AcmeTheme, version: 1.0.0 }
imports:
  UiReact: oci://ghcr.io/telorun/ui-react
  Radix: oci://ghcr.io/telorun/ui-react-radix
exports:
  resources: [theme]
---
kind: UiReact.Theme
metadata: { name: theme }
stylesheets: [!module-path ./acme.css]
controls: [!ref Radix.controls]
```

The theme's stylesheet styles every part and gives every token a value, as
any theme's must; nothing of `Radix.theme`'s look is inherited. A set of its
own may add controls `Radix.controls` does not implement — the entries, the
switch, the slider, the option group — bundling whatever it uses. It cannot
replace one of the eight layer controls beside `Radix.controls`: two entries
of a theme's `controls` implementing one control are refused
(`UI_THEME_CONTROL_DUPLICATE`), and a set
implementing one layer control implements all eight
(`UI_CONTROLS_LAYERS_PARTIAL`). A theme wanting other layer controls ships all
eight in a set of its own and does not list `Radix.controls`.

## Checking it

The module's tests run `UiReactConformance.CheckTheme` on `Radix.theme` and
on a theme of another module built as above, and
`UiReactConformance.CheckControls` on `Radix.controls`, each answering no
problem. A theme built on these controls runs `CheckTheme` on itself the same
way.
