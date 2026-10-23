# UiReact.Theme

A theme is how every screen of an application looks: stylesheets written
against [the styling contract](styling.md), default values for the brand
tokens, and — optionally — its own implementation of some of the renderer's
interactive controls. An application picks one with one reference, and its
brand stays a separate [`Ui.DesignTokens`](../../ui/docs/design-tokens.md) set
under `tokens:`, so changing the theme keeps the brand and any brand works
under any theme.

```yaml
kind: UiReact.App
metadata: { name: console }
title: Reports
words: !ref Ui.words
theme: !ref UiReact.defaultTheme
tokens: { kind: Ui.DesignTokens, color.accent: "#1d4ed8", radius.md: 6px }
stylesheets: [!module-path ./console.css]
```

A `Telo.Provider`, closed:

| Field | | |
| --- | --- | --- |
| `tokens` | | a `Ui.DesignTokens`: the theme's token values and typefaces, under any the application sets |
| `stylesheets` | | the theme's look, as host paths in order: `!module-path ./look.css` |
| `controls` | | `UiReact.Controls` sets drawn in place of the built-in controls they implement; no two entries may implement one control (the same set listed through two aliases included), and the nine layer controls come from one set or none |

A look of an application's own is a theme holding only stylesheets:

```yaml
theme:
  kind: UiReact.Theme
  stylesheets: [!module-path ./look.css]
```

A module publishing a theme declares it with `kind: UiReact.Theme` (or
`Self.Theme` inside `ui-react`) and lists it under `exports.resources`; an
application then writes `theme: !ref <Alias>.<name>`.

## What the application does with it

- The theme's `tokens` become custom properties at the start of the
  `telo.theme` layer, then each of its `stylesheets` follows in that layer, in
  order, then the application's chosen `tokens` (see [layers](styling.md#layers)).
  A stylesheet is plain CSS: it is served as written and imported into the
  layer by the application, so it never declares the layer itself. It is
  served on its own, so it reaches any other file by an absolute URL only;
  typefaces come in through the token set's `font.` tokens.
- Each control set's browser entry is served as content-addressed files, its
  module named in the application document's `controls.sets` with the
  controls it implements, and its own stylesheet placed in the
  `telo.control` layer. The mechanics stylesheet of each built-in a set
  replaces is not served; every other built-in's is.
- What crosses to the browser is data: URLs and export names, never code
  generated per application.

A theme's stylesheets style the parts of the styling contract and declare no
[reserved property](styling.md#reserved-properties) on them; a token a theme
reads should have a value in the theme itself.

## The default theme

`UiReact.defaultTheme` is the instance this module exports: one stylesheet,
no `controls`. It styles every part of the styling contract — the picker, the
date range, field groups and field descriptions included — declares no
reserved property, and gives every token a value, light and dark; how it reads
the tokens is under [Tokens](styling.md#tokens). A sidebar is a column on the
surface colour under the sticky header, staying in view while the page
scrolls, with its toggle at its top; a tab bar is a row on the surface colour
along the bottom edge, its tabs spread across it; tabs are a row over a
hairline, the chosen one underlined in the accent. It has no standing a theme
of another module lacks.

On a narrow screen — while the `app` part carries `data-compact="true"` — it
lays the same parts out to fit the width: the header scrolls away with the
page instead of staying at the top, and the `nav-menu` button, the title (cut
short when it must be), `header-start` and `header-end` share one row; a
filter's bounds and every filter control shrink and
wrap, so no filter is wider than the screen; and `table-frame` shows a shadow
at an edge while more columns lie beyond it. It draws nothing the wide layout
does not, and needs no script.

## Control sets

A `UiReact.Controls` resource is declared in the library that ships the code:

```yaml
kind: Telo.Library
metadata: { name: AcmeTheme, version: 1.0.0 }
imports:
  UiReact: oci://ghcr.io/telorun/ui-react
exports:
  resources: [theme]
  browser:
    - specifier: "@acme/controls"
      path: ./browser/controls.js
      source: ./nodejs/src/controls.tsx
      abi: ui_react_controls-2
      external: [react, react/jsx-runtime, react-dom]
      exports: [Checkbox, Switch, Icon]
---
kind: UiReact.Controls
metadata: { name: controls }
entry: "@acme/controls"
implements: [Checkbox, Switch, Icon]
---
kind: UiReact.Theme
metadata: { name: theme }
stylesheets: [!module-path ./theme.css]
controls: [!ref controls]
```

| Field | | |
| --- | --- | --- |
| `entry` | required | the specifier of one of the declaring module's browser entries |
| `implements` | required, at least one, unique | control names from the closed set of [the controls contract](controls-abi.md); each one the entry exports |

A control the theme's sets do not implement is drawn by the built-in. Two
entries of `controls` implementing one control are refused, the same set
listed through two aliases included: entries are counted, so each control has
one implementation. A control set is written against [the controls
contract](controls-abi.md).

Any subset of the fifteen controls that draw in place — the entries, the
choices, `Listbox`, `Tabs` and `Icon` — may be replaced, from any number of
sets. The nine [layer controls](controls-abi.md#layers) — `Select`,
`MultiSelect`, `Dialog`, `Drawer`, `Popover`, `Confirmation`, `Menu`, `Tooltip`
and `Navigation` — are replaced as one unit: a set implementing any of them
implements all nine, so
every layer on a page comes from one implementation, the built-ins' or one
set's. A primitive library keeps one stack of the layers it draws, and two
stacks cannot be made to cooperate: one cancels the Escape or traps the focus
the other needs.

## Checking a theme

A module publishing a theme or a control set holds it to the renderer's
contract from its own tests, with
[`ui-react-conformance`](../../ui-react-conformance/README.md):
`UiReactConformance.CheckTheme` reports every part the theme leaves unstyled,
every reserved property it sets, every design token it gives no value or never
reads, every scene that breaks under its controls and every vector a set fails; `UiReactConformance.CheckControls` runs the vectors of
one set. `ui-react` runs `CheckTheme` on `UiReact.defaultTheme`.

## What is refused

| What is wrong | `telo check` | at creation |
| --- | --- | --- |
| `theme:` missing, `defaultTheme:` written, an unknown key, a control name outside the set, a name listed twice, an unknown token | `SCHEMA_VIOLATION` | `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` |
| `theme:`, `controls:` or `tokens:` naming the wrong kind | `REFERENCE_KIND_MISMATCH` | the kernel's reference refusal |
| `entry` not a browser entry of the declaring module | `BROWSER_ENTRY_UNKNOWN` | `ERR_BROWSER_ENTRY_UNKNOWN` |
| an implemented control the entry does not export | `BROWSER_EXPORT_UNKNOWN` | `ERR_BROWSER_EXPORT_UNKNOWN` |
| an entry written against another generation than `ui_react_controls-2` | `BROWSER_ENTRY_ABI_UNSUPPORTED` | `ERR_BROWSER_ENTRY_ABI_UNSUPPORTED` |
| an entry leaving anything but `react`, `react/jsx-runtime`, `react-dom` to its host | `BROWSER_ENTRY_IMPORT_UNSUPPLIED` | `ERR_BROWSER_ENTRY_IMPORT_UNSUPPLIED` |
| two entries of a theme's `controls` implementing one control (the same set listed through two aliases included), reported at each entry | `RESOURCE_RULE_VIOLATED` with `data.rule: UI_THEME_CONTROL_DUPLICATE` | `ERR_UI_THEME_CONTROL_DUPLICATE` |
| a set implementing some of the nine layer controls but not all of them — the eight of `ui_react_controls-1` without `Navigation` included | `RESOURCE_RULE_VIOLATED` with `data.rule: UI_CONTROLS_LAYERS_PARTIAL` | `ERR_UI_CONTROLS_LAYERS_PARTIAL` |
| a stylesheet path missing or relative | `MODULE_PATH_NOT_FOUND` / `HOST_PATH_RELATIVE` | their twins |

A control set from an imported library has its `entry` and exports checked at
the `imports:` entry reaching it. A resource rule — `UI_CONTROLS_LAYERS_PARTIAL`
on a set, `UI_THEME_CONTROL_DUPLICATE` on a theme — is reported where that
resource is declared; one declared in an imported library is refused when the
application starts. In the browser, a control that does not load or throws is drawn
as an `error` node in its place (`ERR_UI_THEME_CONTROL_LOAD_FAILED`,
`ERR_UI_THEME_CONTROL_FAILED`), never replaced by the built-in.
