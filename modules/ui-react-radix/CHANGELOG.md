# Changelog

## 0.2.0 - 2026-10-23
### Added
* Draws Navigation — in a row or a rail on Radix's navigation menu, each open group's panel at the end of <body>, placed against its button by the primitives' popper, a nested group a submenu of its own; in a column each group's entries in place beneath its button, with no portal or popper; a group's button naming its panel by aria-controls only while it is open, and an entry opening a dialog drawn as a button (aria-haspopup="dialog") expanded while its key is open — and Tabs on Radix's tabs, and styles the navigation parts, nav-group included.
* New module: ui-react-radix exports theme, a UiReact.Theme in Studio's look that styles every part light and dark with the brand's token defaults, and controls, a UiReact.Controls set drawing Select, MultiSelect, Listbox, Checkbox, Dialog, Drawer, Popover, Confirmation, Menu, Tooltip, Navigation, Tabs and Icon on one copy of Radix's primitives and Lucide's icons (browser entry @telorun/ui-react-radix, ui_react_controls-2). An application switches to it with theme: !ref Radix.theme; a theme of another module takes controls whole beside a stylesheet of its own. Its tests hold both to the renderer's contract with UiReactConformance.
* On a narrow screen (`data-compact="true"` on the `app` part) the theme fits the same parts to the width: the header scrolls away with the page and its title, start and end share one row; filter bounds and controls shrink and wrap so no filter is wider than the screen; and a table frame shows an edge shadow while more columns lie beyond it.
* Radix's Navigation draws an entry's icon before its label in a row, a column and a panel, and in a rail in place of the first letter; the Radix theme sizes the glyph and stacks a tab's glyph over its text.
* The Radix theme's header spans the full window width with tighter spacing, so the title, the navigation and the header's own nodes fit one row.
* The Radix theme styles the nav-menu button opening the navigation on a narrow screen, and drops its nav-link rules: the header's navigation is drawn by the Navigation control.
* The Radix theme styles the sidebar, its toggle and its rail, the bottom tab bar, and the tabs of a tabs node.
### Fixed
* The theme draws a chosen picker value that links somewhere in the accent colour with an underline, wraps long unbroken text, values and links inside their box, cuts a long filter chip with an ellipsis, insets sliders so the thumb stays inside its column at either end, and spaces the controls of a filter bar further apart.
