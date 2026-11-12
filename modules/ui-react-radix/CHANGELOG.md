# Changelog

## 0.9.0 - 2026-11-12
### Added
* Styles for the markdown annotation control, the button node and the time element.

## 0.8.0 - 2026-11-09
### Added
* Draws Combobox on Radix at ui_react_controls-4, the search box's suggestion list on Radix's popover, and styles the search box, its chips and the suggestion list.
* Draws the maximize glyph of the controls contract's closed glyph set.
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.7.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.7.0 - 2026-11-06
### Added
* Draws the controls of ui_react_controls-3, its Icon control gaining the attach, copy, export, regenerate, send and stop glyphs, and styles the chat composer's frame when the buttons sit inside the message box.
* Draws the go, panel-close and panel-open glyphs, draws expand and collapse as chevrons, and styles the frame of a split view's aside and of a list layout, the split toggle's mirrored glyph and a link drawn as a button in the Radix theme.
* Its Tabs control takes the fill prop, marking its root and the shown panel with data-fill and passing the room on to the panel's content, and the theme styles the bar and command parts, draws a chat header's bar at the header's height, and scopes its button, badge and bar heights and a flush split's vertical clipping to parts that do not fill.
* Styles a flush split view as one panel with a rail when folded, the data-embedded frames, the split-bar part, the shared bar height --ui-react-bar-height and the one-line list record with its hover fill in the Radix theme.
* Styles the chat-* parts the ui-react renderer draws for a chat node — the transcript, tool and approval cards, attachments and the message box — with the existing design tokens.
* Styles the markdown-* parts the ui-react renderer draws for a markdown node, tables, task lists and highlighted code blocks included, with the existing design tokens.
* Styles the split, split-aside, split-content and split-toggle parts of the split view in the Radix theme.
* The Icon control draws the done glyph (a check mark), shown on a chat button while it confirms a press.
* The Menu control draws disabled entries with a hint, and the theme styles the record actions menu button.
* The theme draws a chat message's buttons under its card, and rounds and clips a flush split view's content to the split's outer corners.
* The theme lays a split view's aside actions out under the bar as a row with a gap, and as a column in the rail.
* The theme styles the chat's picture thumbnails (chat-attachment-thumbnail) and the media viewer's parts.
* The theme styles the current location: a link with aria-current="page" is emphasised and a record with data-selected is filled.
### Fixed
* No longer styles the chat-earlier part, which the renderer no longer draws: earlier messages are read as the transcript is scrolled.

## 0.5.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.5.0 - 2026-11-01
### Added
* The theme styles a listing's parts and the Load more button and a list's empty cell. Breaking: its rules for the table's toolbar, create button, main area, empty and loading cells now select listing-toolbar, listing-create, listing-main, listing-empty, listing-loading and list-empty, and the panel beside the records sits in listing.
* The theme styles the listing layouts: the sort control, list items, cards, board columns and cards, the calendar's header, days and events, the timeline's axis, lanes and bars, the tree's items and levels, a record's Move to and create buttons and its inline form's place.

## 0.3.0 - 2026-10-23
### Added
* The theme sets its page measure and inset as the `width.page` (`72rem`) and `space.page` (`1.5rem`) design tokens instead of `max-width` and inline padding on the `page`, `main` and `header` parts, and styles the header's row through the new `header-content` part, so a full-width page and a header lined up with a contained page work under it.

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
