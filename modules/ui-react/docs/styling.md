# The styling contract

Everything the renderer draws is an element carrying `data-telo-part`, and
state is carried in `data-` attributes. The lists below are closed and are the
contract: a stylesheet written against them keeps working while the parts and
states it names are in the list. The list is closed **per `ui-react` release**:
a part or state is added, renamed or removed only in a release, and the
release's changelog names each. A stylesheet still written against a renamed or
removed part draws that part with the base layer alone, which holds every
reserved property below, and
[`CheckTheme`](theme.md#checking-a-theme) reports each part the release added
as `part-unstyled`.

Every text box, choice, list, overlay, menu, navigation, tooltip and glyph is
drawn by a control — the built-in one, or a theme's that replaces it — under the
[controls contract](controls-abi.md), which lists the parts and states each
control draws. The built-ins are drawn on the DOM itself, each in its role's
WAI-ARIA pattern, with Lucide's icons; the renderer carries no primitive
library. A dialog, a drawer, a popover, a confirmation, a choice list, a menu,
a navigation panel of a row or a rail and a tooltip are drawn at the end of `<body>`, outside the
`app` part, each in a layer whose root carries `data-telo-layer`, so select
them by their own part and never as a descendant of `app`, `listing`, `form`,
`filters` or `navigation`. A
built-in's mechanics place its list or its popover through custom properties
of its own (`--ui-react-control-anchor-width`,
`--ui-react-control-available-height`, `--ui-react-control-origin`), set on
the layer as it is placed; they are no part of this contract, and a theme
reads none of them. `--telo-` custom properties are the design tokens'; a
control's or a theme's own properties use another prefix.

```css
[data-telo-part="table-row"][data-style~="muted"] { opacity: 0.6; }
[data-telo-part="nav-item"][data-current="page"] { font-weight: 700; }
```

## Layers

| Order | Layer | Holds |
| --- | --- | --- |
| 1 | `telo.base` | the layout of the renderer's own composition: the shell, structure nodes, listings, table and list grids, panel and aside placement, field arrangement, filter placements, in-flow surfaces, hiding by state, a surface body's scroll with its actions sticky |
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
breaks — `UiReact.defaultTheme` declares none. A reservation with a state in
**While** holds only while the part carries it, and one naming no part holds on
every part carrying the state — so a theme scopes a rule it means for parts at
rest, `[data-telo-part="component"]:not([data-fill="true"]) { min-height: 4rem }`.

| Part | While | Reserved | Because |
| --- | --- | --- | --- |
| `filters-bar` | — | `display` | a closed collapsible bar is hidden |
| `filters` | — | `display`, `grid-template-columns` | a bar placed aside sits beside what it filters |
| `surface-body` | — | `overflow-y`, `min-height` | a surface's body scrolls while its header stays |
| `form-actions` | — | `position`, `bottom` | a form's actions stay at its surface's bottom edge |
| `table-frame` | — | `overflow-x` | a grid wider than its table scrolls in its frame |
| `markdown-table-frame` | — | `overflow-x` | a table wider than the text scrolls in its frame |
| `markdown-code-pre` | — | `overflow-x` | a long line of code scrolls in its block, not the page |
| `markdown-code-header` | — | `display` | a block's language and its copy control share one row |
| `chat` | — | `display`, `grid-template-columns` | the conversations sit beside the transcript and the message box |
| `bar` | — | `display`, `grid-template-columns` | a bar's centre stays centred whatever its start and end hold, and its regions wrap below the breakpoint |
| `chat-transcript` | — | `overflow-y`, `overflow-anchor` | the transcript scrolls while the message box stays, and keeps its reading position itself |
| `chat-image` | — | `width`, `height`, `object-fit` | a picture is a fixed-size square crop, so a message's height does not change when it loads |
| `chat-attachment-thumbnail` | — | `width`, `height`, `object-fit` | a picture is a fixed-size square crop, so a file's chip does not change size when it loads |
| `media-viewer` | — | `display`, `flex-direction` | the stage takes the room the toolbar leaves |
| `media-viewer-stage` | — | `overflow-x`, `overflow-y`, `touch-action` | a zoomed picture is panned inside its stage, which clips it and takes the gestures itself |
| `media-viewer-image` | — | `transform`, `max-width`, `max-height` | the renderer zooms and pans the picture, which is fitted to its stage |
| `chat-message` | — | `margin-top`, `margin-bottom` | a message drawn stands in for the messages out of view beside it with its block margins |
| `chat-announcer` | — | `position`, `clip-path` | announcements are read aloud and never drawn |
| `split` | — | `display`, `grid-template-columns` | the aside sits beside the content while it is open |
| `aside` | — | `display`, `width`, `grid-column` | the aside is as wide as its size says, on its side, and a folded one is a rail holding only its bar and actions |
| `split-content` | — | `grid-column` | the content takes the column the aside leaves |
| `listing` | — | `display`, `grid-template-columns` | a panel sits beside the records and the pager |
| `listing-toolbar` | — | `order` | the toolbar stays above a panel |
| `surface` | — | `order` | a panel sits on its side |
| `app` | — | `display`, `grid-template-columns` | a layout's aside sits beside the page |
| `tab-bar` | — | `position`, `bottom` | a tab bar stays at the bottom edge |
| `glyph` | — | `background-color`, `mask-image` | a glyph is its file's shape in the colour of the text around it |
| `page` | — | `max-width`, `margin-inline` | a contained page is no wider than the width.page token, centred |
| `header` | — | `display`, `grid-column`, `padding-inline` | the header spans the application, above the aside and the page, and its content holds the inset |
| `header-content` | — | `padding-inline` | a contained header's content starts and ends where a contained page does |
| `footer` | — | `display`, `grid-column`, `padding-inline` | the footer spans the application, below the aside and the page, and its content holds the inset |
| `footer-content` | — | `padding-inline` | a contained footer's content starts and ends where a contained page does |
| `main` | — | `padding-inline` | the page column is inset by the space.page token |
| `calendar-grid` | — | `display`, `grid-template-columns` | a calendar's days are a grid of seven weekdays, or of the one day shown |
| `timeline-axis` | — | `display`, `grid-template-columns` | a timeline's columns are the periods of its scale |
| `timeline-track` | — | `display`, `grid-template-columns` | a bar spans the columns of the periods it lasts |
| — | `data-fill="true"` | `flex-basis`, `flex-grow`, `flex-shrink`, `height`, `min-height`, `overflow-y` | a filling node takes the room its container leaves, the last of a chain scrolling inside itself and the page scrolling below their minimum |
| `app` | `data-fill="true"` | `grid-template-rows`, `height`, `min-height` | a filling page holds the application to the viewport's height |
| `box` | `data-fill="true"` | `display`, `flex-direction` | a filling box passes the room on to what it holds |
| `data` | `data-fill="true"` | `display`, `flex-direction` | a filling reader passes the room on to what it holds |
| `columns` | `data-fill="true"` | `align-items` | filling columns are each as tall as the row |
| `filters` | `data-fill="true"` | `align-items`, `flex-direction`, `flex-wrap`, `grid-template-rows` | a filling filter bar passes the room left under its controls on to its content |
| `split` | `data-fill="true"` | `align-items` | a filling split view stretches its aside and its content to its height |

A shorthand or a longhand that sets a reserved property counts as setting it:
`padding`, `padding-left` or `padding-inline-start` on `header` or `footer`, `grid-area` on
`header`, `margin` or `margin-left` on `page`, `margin`,
`margin-block` or `margin-block-start` on `chat-message`, `flex`, `flex-flow`,
`block-size`, `min-block-size`, `overflow` or `place-items` on a filling part. Write a header's or the main area's block padding with
`padding-block` (or `padding-top` / `padding-bottom`).

## Tokens

A [`Ui.DesignTokens`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) token is a custom
property: `color.accent-text` is `--telo-color-accent-text` (the projection the
code entry `@telorun/ui-react-contract` exports as `tokenProperty`). A theme gives
every token a value — from its own `tokens`, or from its stylesheets — and
reads them for colours, spacing, radii, shadows and type, so an application's
`tokens` change the brand under any theme.

Two tokens are read by the base layer rather than by a theme, and the contract
lists them as `rendererTokens` in its parts data:

- `width.page` (`--telo-width-page`) is the widest a page's content is drawn
  while it carries `data-width="contained"`, centred; under
  `data-width="full"` the page has no maximum.
- `space.page` (`--telo-space-page`) is the inline space between the room a
  page has and its content: `main`'s inline padding, and the inset of the
  header's and the footer's content.

The header's and the footer's content use the same expression over the room
they have: under `data-width="full"` on `header` or `footer` it is inset by
`space.page`; under `contained` by the larger of `space.page` and half of what
`width.page` leaves — so it starts and ends exactly where a contained page does
in an application with no aside, at every viewport width, whatever width the
page declares: the width of the header and the footer is the layout's. With an
aside, `header` and `footer` span every column of `app` above and below the
aside and `main`, so a contained header's content keeps the application's
measure rather than `main`'s. A theme gives both tokens a
value — `UiReact.defaultTheme` `64rem` and `1.5rem` — and, as the properties
that apply them are reserved, sets the measure and the inset only through the
tokens.

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

## Filling

A node the page document marks `fill` is drawn with `data-fill="true"` on its
root part (on `navigation` for a `menu` node, on `tabs` and the shown
`tab-panel` for a `tabs` node), and a filling split view marks `aside`
and `split-content` too. While one of the page's own nodes fills, `app`, `main`
and `page` carry it as well: the application is as tall as the viewport (in
dynamic viewport units, so an on-screen keyboard does not hide the message box)
and `page`, under the header and above the footer and a tab bar, is the one part that scrolls
— only when what fills it is taller than the room. Otherwise:

- a filling part takes the room its container leaves after its other children,
  filling siblings sharing it equally;
- a filling part holding a filling part passes the room on and never scrolls;
  it is never shorter than what it holds;
- the last filling part of a chain scrolls inside itself — a chat in its
  transcript, as always, and a split view's half in itself — and is as short as
  the room makes it, a chat no shorter than `24rem`;
- inside a record, an action's answer, a chat's header, a split view's actions,
  an in-line surface or a panel, a filling part grows to the room but is as tall
  as its content: those boxes grow with what they hold;
- a filling filter bar above its content draws its controls one under another,
  so the content takes the room left under them.

The properties this takes are reserved while `data-fill="true"` is carried; see
[reserved properties](#reserved-properties).

## Parts

### Shell

The shell is a [layout](app.md#layouts) around the page: its `header`, `aside`
and `footer` landmarks stand around `main`, which holds the page. A page drawn
with no layout is `main` alone.

| Part | Is |
| --- | --- |
| `app` | the whole application; `data-side` is the side of its layout's aside while that stands beside `main` |
| `header` | the `<header>` landmark holding the layout's `header` nodes, its only child `header-content`; spans every column of `app` above the aside and `main`; `data-width` is the layout's width; drawn only when the layout has header nodes |
| `header-content` | the header's row: the layout's header nodes, each in its place, and — below the breakpoint — the compact aside's rail at the edge on the aside's side; inset against the application's width, the same open, folded or compact, so it lines up with a contained page drawn with no aside beside it, under the header's `data-width="contained"` |
| `navbar` | a `navbar` node: one row of `navbar-start`, the title, `nav` taking the room left, `navbar-end`, and `nav-menu` first (or last, for a drawer opening from the end edge) when the navigation is behind a menu button — one row while the application is not compact, wrapping when it is |
| `navbar-start` | the navbar's own `start` nodes before the title; drawn only when there are any |
| `navbar-title` | the navbar's title |
| `nav` | the slot of a navigation drawn in the navbar, holding the [`Navigation` control](controls-abi.md#navigation) in a row; what does not fit moves under More |
| `nav-menu` | the menu button opening a navigation placed behind it: the whole tree, in a column, in the surface it opens; `aria-expanded="true"` while that is open |
| `navbar-end` | the navbar's own `end` nodes after the navigation; drawn only when there are any |
| `nav-column` | a `navigation-column` node: the [`Navigation` control](controls-abi.md#navigation) in a column whose groups open in place, or — in a folded `aside` — in a rail; anywhere else a plain column |
| `main` | the area between the header and the footer, beside the layout's [aside](#aside) |
| `page` | the current page |
| `footer` | the `<footer>` landmark holding the layout's `footer` nodes, its only child `footer-content`; spans every column of `app` below the aside and `main`; `data-width` is the layout's width; drawn only when the layout has footer nodes |
| `footer-content` | the footer's row: the layout's footer nodes, inset against the application's width, so it lines up with a contained page drawn with no aside beside it, under the footer's `data-width="contained"` |
| `tab-bar` | the bar along the bottom edge holding a navbar's navigation placed as a tab bar: the `Navigation` control in a row, its top-level entries as tabs and More last when there are more than it shows; a group's tab and More open their entries in a surface, in a column; drawn last in `app`, whichever region holds the navbar |

`header-content` and `footer-content` are a break in this contract: a region's
nodes are children of the content, not of the landmark, so a rule written
`[data-telo-part="header"] > [data-telo-part="navbar"]` matches nothing and
must go through `header-content`. A row's `gap` and `min-height` belong on
`header-content` or `navbar`; the bar's background, border and block padding stay
on `header` and `footer`.

A text of the `title` style is drawn as the page's `h1` (`heading` is `h2` and
`subheading` `h3`); the page's own `title` is the document title and the
navigation text alone, so no part holds it.

### Structure

| Part | Is |
| --- | --- |
| `box` | a `box` node |
| `stack` | a `stack` node |
| `columns` | a `columns` node |
| `column` | one child of `columns` |
| `text` | a `text` node — `p`, or `h2` / `h3` under `heading` / `subheading` |
| `badge` | a `badge` node |
| `link` | a `link` node; drawn as a button, an `<a>` with `data-button`, a glyph alone named by `aria-label`, and an `Icon` the look mirrors in a right-to-left page |
| `image` | an `image` node |
| `svg` | an `svg` node, drawn as an image |
| `value` | a `value` node: one value of a data scope, presented as its schema says — a `format: uri` / `uri-reference` string as a `link` |
| `time` | a `time` node, or the value of a time column: a `<time>` whose `datetime` is the machine-readable time, its text relative to now with the exact time as its `title`, or absolute; a value that is no date is a `span` holding its text |
| `list` | a `list` node, or one list of an action's answer: its heading, then its grid |
| `list-heading` | a list's heading, an `h3`; absent when the list declares none |
| `list-empty` | the cell a list shows when its rows hold none |
| `data` | a `data` node: a reader, holding its `loading` tree before the first answer, its `content` once one is in, its `failure` when the read did not succeed |
| `bar` | a `bar` node: its three regions in a row, `bar-center` centred whatever the sides hold; below the breakpoint the regions wrap. A bar is as tall as every bar (`--ui-react-bar-height`) |
| `bar-start` | the bar's `start` nodes, at its start edge |
| `bar-center` | the bar's `center` nodes; drawn, empty, when there are none |
| `bar-end` | the bar's `end` nodes, at its end edge |
| `command` | a `command` node: a `<button>` running a command of the place it is in — `data-command` names it, `data-button` how it is drawn — disabled while it cannot run, not drawn where it is not offered; a glyph alone is named by `aria-label` and a tooltip |
| `button` | a `button` node: a `<button>` running its action, labelled with the action's label — `data-button` says how it is drawn, `data-state="submitting"` while its press is pending; once the action has answered, its `row-answer` stands in its place, and a failure is its `row-failure` beside it |

A column of a `list` whose `shown` does not hold is left out, header and cells.

A `menu` node is drawn by the `Navigation` control as one group: a
`navigation` that is no landmark, holding one `nav-toggle` that opens a
`nav-panel` of `nav-item` links. The current choice — a link whose style holds
`strong` — carries `aria-current="true"` and `data-current="true"`, and one
whose address leads to where the viewer is carries `aria-current="page"`, which wins where both hold. Its
`style` is on `navigation` as `data-style`.

**Changed:** a `menu` node has no `menu-trigger`, and its links are no
`menu-item`s; a rule written for either selects nothing now.

### Markdown

The parts of a [`markdown` node](markdown.md). The `markdown` part is the
node's root, `data-state="loading"` while the renderer's chunk is fetched (its
text then in one `markdown-code-pre`) and `idle` once it has drawn; its `style`
is on it as `data-style`.

| Part | Is |
| --- | --- |
| `markdown` | the node's root, holding its blocks |
| `markdown-paragraph` | a paragraph, a `p`; a tight list item has none |
| `markdown-heading` | a heading, `h1` to `h6`, its depth in `data-level` |
| `markdown-quote` | a block quote |
| `markdown-list` | a bulleted or numbered list, `ul` or `ol` |
| `markdown-list-item` | one entry of it |
| `markdown-task` | the box of a task list's entry, a read-only `role="checkbox"` named by the entry's text, `aria-checked` when ticked |
| `markdown-rule` | a thematic break |
| `markdown-emphasis` | emphasised text, an `em` |
| `markdown-strong` | strong text |
| `markdown-strike` | struck-through text, a `del` |
| `markdown-code` | inline code |
| `markdown-link` | a link that passed the address rule; an external one has `target="_blank"` |
| `markdown-image` | an image that passed it |
| `markdown-break` | a hard line break |
| `markdown-table-frame` | the frame a table scrolls in when it is wider than the text |
| `markdown-table` | a table |
| `markdown-table-head` | its head |
| `markdown-table-body` | its body |
| `markdown-table-row` | a row of either |
| `markdown-table-header-cell` | a head cell, its column's alignment in `data-align` |
| `markdown-table-cell` | a body cell, with `data-align` too |
| `markdown-code-block` | a fenced code block |
| `markdown-code-header` | its row: the language, then the copy control |
| `markdown-code-language` | the language the block was written with; drawn only when it names one |
| `markdown-code-copy` | the button copying the block's code |
| `markdown-code-pre` | the block's `pre`, focusable so a wide block scrolls from the keyboard; also the preformatted text shown before the chunk arrives |
| `markdown-code-text` | the `code` inside it |
| `markdown-token` | a highlighted run of code, its kind in `data-token` |
| `markdown-annotations` | the controls of the annotations on one block, in order, inside it: at the end of a heading, a paragraph, a quote, a code block or a table's frame, after the first block of a list item |
| `markdown-annotation` | one annotation's control: its `row-action` button, then the `badge` holding its count when it has one, and the `row-answer` or `row-failure` of a press |
| `markdown-unplaced-annotations` | after the text, the `markdown-annotation`s whose line is past it; drawn only when there are any, and holding every annotation while the chunk is fetched |

### Chat

The parts of a [`chat` node](chat.md). Every control the chat draws is a part:
an element is drawn in the part named here, and the controls beneath it
(`textarea`, `input`, `menu`, `surface`) are the ones documented elsewhere. The
upload control and the conversations appear only where the node's spec offers
them, so a theme styles parts that a given chat never draws.

| Part | Is |
| --- | --- |
| `chat` | the node's root: the transcript and the message box; `data-state` is `loading` while a conversation is read, `submitting` while a reply is written, `error` after a failed request, `empty` with no messages |
| `chat-main` | the transcript and the message box together |
| `chat-header` | the `<header>` above the transcript holding the chat's header nodes top to bottom, as tall as a bar at least; not drawn when the header holds none. A failed export or copy is drawn under it as an `error` |
| `chat-transcript` | the scrolling feed of messages, `role="feed"`, focusable so it scrolls from the keyboard. Only the messages near its viewport are drawn, the others standing in as the block margins of the nearest drawn one, so messages are spaced by its `gap` and never by margins of their own; while an earlier page is read a `loading` part stands above the first message |
| `chat-empty` | shown in a conversation with no messages |
| `chat-message` | one message, its author in `data-role`, its place in the conversation in `aria-posinset` of `aria-setsize` (`-1` while earlier messages are still to be read) |
| `chat-message-label` | who wrote it |
| `chat-message-body` | its blocks in order: text as `markdown`, reasoning, tool calls, approvals, media, refusals and sources |
| `chat-message-actions` | the row of what can be done with it, under the message's card (`chat-message-body`, or `chat-edit-form` while editing), at the card's edge |
| `chat-copy` | the button copying its text; not drawn when the page turns it off. Like every configurable chat button it holds the text, or by the page's choice a glyph — an `icon` part, or a `glyph` part for an icon of the page's own — with the text as its `aria-label` and tooltip |
| `chat-edit` | the button editing a message you wrote and sending it again as another version |
| `chat-edit-form` | the box a message is edited in: the text box, the message's files as `chat-attachments` (with `chat-attachment-refusals` and `chat-drop` as in the message box) where the endpoint takes attachments, a `chat-attach` button, then a `cancel` and a `submit` button |
| `chat-regenerate` | the button asking for another reply as another version |
| `chat-branches` | the switcher between the versions of a message seen |
| `chat-branch-previous` | shows the previous version |
| `chat-branch-position` | which version is shown, of how many |
| `chat-branch-next` | shows the next version |
| `chat-reasoning` | the model's reasoning, collapsible; `open` while its body is shown |
| `chat-reasoning-toggle` | the button opening and closing it, `aria-expanded` |
| `chat-reasoning-body` | the reasoning as `markdown` |
| `chat-tool` | a tool call's card; `data-status` is `running`, `done` or `failed` |
| `chat-tool-header` | its name, status and details button |
| `chat-tool-name` | the tool's name |
| `chat-tool-status` | drawn while the call runs or once it failed |
| `chat-tool-toggle` | the button showing and hiding its arguments and result |
| `chat-tool-detail` | the arguments and the result |
| `chat-tool-label` | names one of them |
| `chat-tool-data` | a block of text, focusable so it scrolls from the keyboard: a call's argument (a text as written, anything else as JSON, each after a `chat-tool-label` naming it) or its result |
| `chat-tool-block` | a block of text and, when it is cut off, its preview button in the block's top-right corner |
| `chat-tool-preview` | the icon button, a `maximize` glyph, opening a block too long for its box in a dialog; drawn only for such a block |
| `chat-approval` | a call waiting for a decision; `data-status` is `pending`, `approved` or `rejected` |
| `chat-approval-header` | the approval's line: its toggle (or its title alone, where the page hides tool detail), then at the end what was decided and the state glyph |
| `chat-approval-toggle` | the button folding and unfolding the arguments, `aria-expanded`; a call waiting for a decision starts unfolded, a decided one folded |
| `chat-approval-title` | what is asked to run |
| `chat-approval-state` | a glyph at the end of the line: `alert` while waiting, `done` once approved, `close` once rejected, named by `aria-label` |
| `chat-approval-actions` | the reason box and the two buttons, drawn until a decision is made |
| `chat-approval-decision` | what was decided, and why, in the line before the state glyph |
| `chat-approve` | the button approving the call |
| `chat-reject` | the button rejecting it with the reason typed beside it |
| `chat-image` | a picture of a message, drawn only from an app-relative address as a fixed-size square crop of the original; pressing it opens the `media-viewer` at it |
| `chat-media` | an audio or video player for an attachment, drawn only from an app-relative address |
| `chat-attachment` | a file of a message: a link to download it, or its name alone when its address is not app-relative |
| `chat-sources` | the citations of a message |
| `chat-sources-title` | its heading |
| `chat-source-list` | the list of them |
| `chat-source` | one citation, a `markdown-link` to its address |
| `chat-source-quote` | the passage it quotes |
| `chat-refusal` | a refusal the model gave |
| `chat-refusal-title` | its label |
| `chat-usage` | the tokens a reply cost |
| `chat-turn-note` | how a reply ended when it did not simply stop |
| `chat-continue` | the button asking the assistant to go on after it reached its step limit |
| `chat-pending` | shown while a reply is awaited and nothing has arrived |
| `chat-reconnecting` | shown while the stream of events is being reopened, and when it could not be |
| `chat-retry` | the button repeating a request that failed, or reopening a stream that could not be |
| `chat-announcer` | a status region announcing that a reply began and that it is complete; visually hidden |
| `chat-composer` | the form a message is written in; `data-actions` is `inside` while the buttons sit in the message box's frame, `outside` while they sit in a row under it |
| `chat-starters` | the prompts offered on an empty conversation |
| `chat-starter` | one of them, a button sending it |
| `chat-attachments` | the files attached to the message |
| `chat-attachment-item` | one of them; `data-status` is `uploading` or `failed` |
| `chat-attachment-thumbnail` | a picture's small square crop, drawn from the file itself as soon as it is attached; pressing it opens the `media-viewer` over the pictures of that box |
| `chat-attachment-name` | its file name |
| `chat-attachment-progress` | its upload progress, a `progressbar` |
| `chat-attachment-problem` | why it failed, or why a file was not attached |
| `chat-attachment-refusals` | the files refused before any upload |
| `chat-attachment-remove` | the button removing it |
| `chat-placeholder` | the node's placeholder, shown over the empty message box |
| `chat-input` | the wrapper of the message box, a `textarea` part inside; the frame around the box and its buttons while they sit inside |
| `chat-hint` | how the message box sends |
| `chat-composer-actions` | the row of attach and send, after the box in `chat-input` or after `chat-hint` in `chat-composer` |
| `chat-attach` | the button choosing files to attach; drawn only where the endpoint takes attachments |
| `chat-send` | the button sending the message |
| `chat-stop` | the button stopping the reply, in place of send while one is written; drawn only where the endpoint can cancel |
| `chat-drop` | covers the message box while files are dragged over it |

A message's `data-role` is `user` or `assistant`.

### Split view and aside

A [`Ui.SplitView`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/): an aside beside its content.
The aside is drawn once and moves between the page and the compact surface, so
it is the same element in each. A [`Ui.PageLayout`](app.md#layouts)'s aside is
the same shape drawn by the same code, so its parts, states and fold are those
below: beside the page it stands in `app`'s grid, below the breakpoint its rail
stands at the header's edge on its side, or above `main` when the layout has no
header, and its toggle opens the compact surface. A `navigation-column` in a
folded aside stays visible as a rail of glyphs; any other content is hidden.

A `flush` split view is one panel: `split` draws the border and the radius round
both halves, `aside` is separated from the content by one divider, only
tints the same surface and rounds its two outer corners itself (it is not
clipped, so the toggle's focus ring is never cut), while `split-content` rounds
its own outer corners to the split's radius less its border and clips with
`overflow: clip` (no scroll container, so a sticky descendant keeps working),
so content with a square background never paints over the split's border. The renderer marks the direct node of
the content (and of the open aside, beside the content) with `data-embedded`,
and a part that draws a frame of its own — `chat`, `list-layout`, `table-frame`,
`tree-layout`, `calendar-grid`; a listing hands the mark to its layout — drops
its outer border, radius and background while marked, so a frame is never drawn
inside the split's — except a `Ui.ComponentLayout`'s component, which the
[layout contract](layouts-abi.md#the-built-in-layouts) gives no mark, so it
draws no frame of its own when meant for a flush split. A `framed` split is two panels with a gap, and nothing is
marked.

**Folding leaves a rail.** Beside the content, a folded aside is not removed: it
collapses to a rail (`data-state="rail"` on `aside`, where `split` says `collapsed`) that holds only
`aside-bar` — the toggle — and under it `aside-actions`, the entries stacked as glyphs. The bar is the same in
the rail as open, so the toggle stays where it was and the content only
widens. The rail is as wide as the bar's toggle
plus the bar's padding, keeps the aside's divider and border (on the same side,
mirrored for an aside at the end edge), and draws the aside's other children
nowhere. This holds for `framed` too, where the rail is a narrow panel. Below
the breakpoint the same rail stays (a `aside` with `data-state="rail"`, a
plain element rather than a landmark, `split` saying `compact`) and its toggle opens the
compact surface, whose aside is `data-state="compact"` with no bar; `split-content` never holds a toggle.

**Bars line up.** Every bar-shaped part — `bar`, `chat-header`, `aside-bar` —
takes its height from one custom property the theme defines,
`--ui-react-bar-height`, so bars side by side have their bottom lines on one
row: a chat's default header beside a split view's aside ends where the aside's
bar does. A theme defines it once and a bar part it styles uses it as its
`min-height`, counting its bottom border in it (`box-sizing: border-box`), and
gives a `bar` inside `chat-header` none of its own, the header being the bar.

| Part | Is |
| --- | --- |
| `split` | the node's root; `data-frame` is how the aside is set against the content: `framed` two panels with a gap, `flush` one panel round both halves with one divider between them, `data-side` is the aside's side, `data-state` is `open` with the aside beside the content, `collapsed` with it folded to a rail, `compact` with it in the compact surface |
| `split-content` | what the aside sits beside |

### Aside

The `aside` parts are the same in a split view and in a layout.

| Part | Is |
| --- | --- |
| `aside` | the `<aside>` landmark named by the aside's `label`, with `data-side`, `data-size` and `data-frame`; `data-state` is `open` beside the content, `rail` folded to a rail, `compact` in the compact surface |
| `aside-bar` | the aside's top bar holding the toggle alone, the same open and as a rail — drawn while the aside is open or a rail and can fold; it is the height of every bar (`--ui-react-bar-height`) |
| `aside-actions` | the aside's `actions` entries (button links) drawn under `aside-bar` — a wrapping row while open, a column in the rail, where each entry is a glyph alone — drawn when there is at least one |
| `aside-toggle` | the button folding the aside away and showing it, drawn as its display says (a glyph alone is named by `aria-label`; a look mirrors its panel glyph for an aside at the end edge or in a right-to-left page), `aria-expanded` and `aria-controls`: in `aside-bar` at the top of `aside`, open or a rail, when it can fold; below the breakpoint it is in the rail's `aside-bar` and opens the compact surface, on the split view's side, and opens the compact surface |

### Navigation

Drawn by the [`Navigation`](controls-abi.md#navigation) control, which also
carries the states the controls contract lists for it: `data-layout` on
`navigation`, `data-state` on `nav-toggle` and `nav-panel`, `data-current` on
`nav-item` and `nav-toggle`.

| Part | Is |
| --- | --- |
| `navigation` | a tree of links: a `nav` when it is named, else no landmark; a `menu` node's one group |
| `nav-toggle` | a group's button — its `glyph` when the entry has an icon, its text, then an `icon` — opening its `nav-group` or `nav-panel` |
| `nav-item` | a link: its `glyph` when the entry has an icon, then its text; in a rail its glyph alone, or its text's first letter when it has none |
| `nav-group` | an open group's entries in a column (`data-layout="vertical"`), drawn in place right after its `nav-toggle`, inside `navigation` |
| `nav-panel` | an open group's entries in a row or a rail, at the end of `<body>` |

### Tabs

Drawn by the [`Tabs`](controls-abi.md#tabs) control for a [`tabs`
node](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/), which also carries the states the
controls contract lists for it: `data-state` on `tab` and `tab-panel`.

| Part | Is |
| --- | --- |
| `tabs` | a `tabs` node: its `tab-list`, then the chosen tab's `tab-panel` |
| `tab-list` | the row of tabs, `role="tablist"` |
| `tab` | one tab, a button: `aria-selected="true"` and `data-state="active"` on the chosen one |
| `tab-panel` | the chosen tab's content, `role="tabpanel"`; another tab's is drawn anew when it is chosen |

A `data` part carries `data-state`: `loading` before the first answer, `idle`
once one is drawn, `error` while its `failure` is drawn. A reload keeps the
content mounted; while the failure is drawn the content is kept, out of sight.

A node whose `shown` does not hold is drawn inside an element with
`display: none` — kept mounted, so what it holds survives — and one that holds
inside an element with `display: contents`, which no selector needs to reach.

### Listing

What a listing draws whatever its layout: its toolbar, the place its layout
draws the records, its empty state and its paging, and what every layout of
the [layout contract](layouts-abi.md) draws for a record.

| Part | Is |
| --- | --- |
| `listing` | a listing, with everything belonging to it |
| `listing-toolbar` | the row above the records |
| `listing-create` | the button opening the create form |
| `listing-main` | the records and the pager together: what a panel sits beside |
| `listing-empty` | where the records would be when the reads answer none: the listing's `empty` node |
| `listing-loading` | where the records would be until the first page arrives |
| `load-more` | the button reading the next page: under `paging: more` and `scroll`, and in a board's column and a tree's level whatever the paging; at the end of what it reads, focusable, and under `scroll` pressed by itself when it comes into view; `aria-busy` while a page is read |
| `row-actions` | what holds a record's buttons, or its menu button; `data-display` is `inline` with each action a button, `menu` with them folded into one |
| `row-action` | one operation a record offers, a button showing its label; before edit and delete |
| `row-edit` | a record's edit button, an icon |
| `row-delete` | a record's delete button, an icon |
| `row-menu` | the button opening a record's actions as a menu, an icon named by the text `rowActionsMenu`; the menu is a `menu` with a `menu-item` per action, edit and delete, one whose condition does not hold carrying `aria-disabled` |
| `pager` | the paging controls |
| `pager-status` | the range of records shown and the total |
| `pager-prev` | the previous-page button, an icon, under `paging: pages` |
| `pager-next` | the next-page button, an icon, under `paging: pages` |
| `listing-sort` | the viewer's sort in a layout with no headers — list, cards, board, tree: a group of buttons |
| `listing-sort-option` | one property it sorts by, a button showing its title and the sort glyph; `aria-pressed` while the sort is by it |
| `listing-detail` | where a record's edit form opens in line, under the record, in a layout of the contract |
| `record-move` | a record's "Move to" button, opening the `menu` of the places it can be moved to: the keyboard path of every drag |
| `record-create` | the button creating a record in a board's column or on a calendar's day, holding that place's value; an icon |

A related record's label is drawn as its text, or as a `link` where the
relation gives one, in place of the key. In a layout of the contract a
record's element can be dragged while it can be moved — `draggable="true"` —
and a column, a lane, a day, a timeline's column and a tree item take a drop.

### Table layout

| Part | Is |
| --- | --- |
| `table` | the records drawn as a table |
| `table-frame` | the bordered box the grid scrolls in |
| `table-grid` | the `table` element |
| `table-head` | the header section |
| `table-body` | a body section: under `paging: more` and `scroll` one per page read, a page out of view standing in at its height with no part beneath it |
| `table-row` | one record |
| `table-header-cell` | one header cell |
| `table-sort` | the button sorting by a column |
| `table-cell` | one cell |
| `table-detail` | the cell under a record that holds its edit form, opened in line |

The listing's `listing-empty` and `listing-loading` are cells of the grid in a
table, spanning every column.

**Changed:** what a listing draws whatever its layout was named after the
table, which is now one layout among several. `table-toolbar` is
`listing-toolbar`, `table-create` is `listing-create`, `table-main` is
`listing-main`, `table-loading` is `listing-loading`, and `table-empty` is
`listing-empty` in a listing and `list-empty` in a `list`; the `table` part is
the table layout alone, so `data-state` is on `listing`, and the reserved
`display` and `grid-template-columns` moved from `table` to `listing`, and
`order` from `table-toolbar` to `listing-toolbar`.

### List layout

| Part | Is |
| --- | --- |
| `list-layout` | the records one under another: a `list`, `data-frame` its frame |
| `list-item` | one record: its content, its buttons, its inline form |

Under `paging: more` and `scroll` the records are drawn a page at a time while
near the viewport; a page out of view stands in at its height, with no part.

### Card layout

| Part | Is |
| --- | --- |
| `cards-layout` | the records as a grid of cards, `data-size` how wide each is |
| `card` | one record |

### Board layout

| Part | Is |
| --- | --- |
| `board-layout` | the columns, side by side |
| `board-column` | one group's column, named by its label |
| `board-heading` | a column's label and count, and its `record-create` |
| `board-cards` | a column's cards: a list |
| `board-card` | one record |

### Calendar layout

| Part | Is |
| --- | --- |
| `calendar-layout` | the calendar |
| `calendar-header` | the row above the days |
| `calendar-prev` | the button showing the period before, an icon named by that period |
| `calendar-title` | the period shown |
| `calendar-next` | the button showing the period after, an icon named by that period |
| `calendar-period` | one of `month`, `week` and `day`, a button; `aria-pressed` while shown |
| `calendar-grid` | the days, under the weekdays |
| `calendar-weekday` | a weekday's name, above its column |
| `calendar-day` | one day, named by its date; before the first and after the last of a month, a day standing in with nothing in it |
| `calendar-day-label` | a day's number |
| `calendar-event` | one record on a day it spans |

### Timeline layout

| Part | Is |
| --- | --- |
| `timeline-layout` | the timeline |
| `timeline-header` | the row above the axis |
| `timeline-prev` | the button showing the period before, an icon named by that period |
| `timeline-title` | the period shown |
| `timeline-next` | the button showing the period after, an icon named by that period |
| `timeline-scale` | one of `day`, `week`, `month` and `quarter`, a button; `aria-pressed` while shown |
| `timeline-axis` | the columns, a period of the scale each |
| `timeline-tick` | one column's label |
| `timeline-lane` | one group's row of bars, or the one row with no groups |
| `timeline-lane-label` | a lane's label and count |
| `timeline-track` | a lane's bars, on the axis's columns |
| `timeline-bar` | one record, over the columns it lasts |

### Tree layout

| Part | Is |
| --- | --- |
| `tree-layout` | the roots: a `tree` |
| `tree-item` | one record, `aria-expanded` while its children are shown |
| `tree-toggle` | the button showing or hiding a record's children, an icon |
| `tree-children` | a record's children, under it |

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

A list's row actions are drawn as a table layout's are: a last
`table-header-cell` and, per row, a `row-actions` cell holding each
`row-action`, or its `row-answer`.

A `list` draws its rows with the table's own grid parts — `table-frame`,
`table-grid`, `table-head`, `table-body`, `table-row`, `table-header-cell`,
`table-cell` — and `list-empty` when it has no rows, so select a list's grid
as a descendant of `list`, and a table layout's as a descendant of `table`.

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
| `filters-add` | the button listing the filters that are not on show, under the placement's `show: chosen` |
| `filters-apply` | the button applying what was entered in the controls, under `apply: button` |
| `filters-reset` | the button returning every filter to its declared default |
| `filters-summary` | the row of chips, under the placement's `summary: chips` |
| `summary-chip` | one filter holding a value: its label, its operator and the value; the bar's search reads `Search: <text>` |
| `summary-chip-remove` | the button in it that clears that filter, an icon |
| `filters-content` | what the bar filters |
| `filter` | the filters on one property: its label, and one control or a group of them |
| `filter-label` | a property's label |
| `filter-group` | the controls of a property filtered more than one way, side by side |
| `filter-bound` | one of them: its caption and its control |
| `filter-caption` | what tells it from the others: `from`, `to`, `after`, `before`, `is`, `contains`, `one of` |
| `filter-remove` | the button taking a filter off show and clearing it, an icon; never on a pinned filter |
| `filter-chip` | under the placement's `controls: chips`, the button naming a property's filters and what they hold, which opens them; its `title` holds the same text whole, for a theme that cuts it short |
| `filter-input` | a filter typed into, the bar's search box among them, and the box tags are typed into |
| `filter-select` | a filter chosen from a list: the button showing what is chosen |
| `filter-options` | a filter's values side by side, under `control: options` |
| `filter-option` | one of them |
| `filter-toggle` | a switch, under `control: toggle` |
| `filter-slider` | a slider, under `control: slider` |
| `filter-slider-value` | its position as text, after its track: what the filter holds, or `Any` while it holds nothing |
| `filter-tags` | the values typed so far and the box the next is typed into, under `control: tags` |
| `filter-tag` | one typed value |
| `filter-tag-remove` | the button in it that removes that value, an icon |
| `search-box` | under `Ui.SearchBoxPlacement`, the one box of the bar: its chips, then the input; `data-reason` names why the text typed is not a token while nothing is offered for it |
| `search-token` | a chip in it: the search (`Search: <text>`), or a filter holding a value |
| `search-token-remove` | the button in it that clears that filter, an icon |
| `search-input` | the box's input, the root of the `Combobox` control |

**Changed:** a bar's controls are inside `filters-bar` and what it filters
inside `filters-content`; both were direct children of `filters`. A rule
written as `filters > filter` or `filters > listing` selects nothing now.

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

The bar's `show`, `controls` and `summary` are read from the placement drawn —
below the application's breakpoint, its `compact` one. A bar with a search
draws it first, as a `filter` labelled `Search` holding a `filter-input` (a
pinned one stays outside what folds, as any pinned filter does). A placement
this renderer does not draw is drawn as `data-placement="above"`.

`data-placement="searchBox"`: `filters-bar` holds one `search-box` and, after
it, `filters-apply` (under `apply: button`) and `filters-reset`. Inside
`search-box` come the `search-token`s — the search first, then each filter
holding a value, in the bar's order — then the `search-input`; its list is the
`Combobox` control's `combobox-content`. The presets are suggestions in that
list, so there is no `filters-presets`, and nothing folds or is summarised.

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
- `inline` is in the `listing`: above `listing-main` for the create form, and
  for an edit under its record — in a table layout, in a `table-detail` cell.
- `panel` is in the `listing`, beside `listing-main`, on its `data-side`.
- `page` is in the `page`, where its content was; the content is not drawn
  until the surface closes.

### Media viewer

The full-screen viewer a picture opens, drawn in a `dialog` surface (`data-surface="dialog"`, `data-size="full"`) with the `surface-header`, `surface-title` and `surface-close` parts. It steps through every picture of the conversation loaded so far — or the pictures attached to one message box — and starts each one fitted. The renderer animates nothing in it, so reduced motion needs no rule.

| Part | Is |
| --- | --- |
| `media-viewer` | what the surface holds under its title: the stage and the toolbar |
| `media-viewer-stage` | the clipped area the picture is zoomed and panned in; a wheel, pinch, drag, swipe or double click acts on it |
| `media-viewer-image` | the picture, named by its file name; its zoom and offset are set inline |
| `media-viewer-toolbar` | the row of controls under the stage |
| `media-viewer-previous` | shows the previous picture, wrapping to the last; drawn only over more than one picture |
| `media-viewer-position` | `1 of 3`, a `status`; drawn only over more than one picture |
| `media-viewer-next` | shows the next picture, wrapping to the first; drawn only over more than one picture |
| `media-viewer-zoom-out` | zooms out about the stage's centre |
| `media-viewer-zoom-reset` | returns the picture to its fitted size |
| `media-viewer-zoom-in` | zooms in about the stage's centre |
| `media-viewer-download` | a link to the original, naming its file |

### Shared

| Part | Is |
| --- | --- |
| `icon` | every icon: in a button, a choice control, a list entry, an error or loading node |
| `glyph` | the glyph of an [icon resource](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) — a navigation entry's, drawn before its text and alone in a rail: the icon's file as a mask over `currentColor`, so it takes the colour of the text around it; hidden from assistive technology |
| `select-content` | the open list of a `select` or a `filter-select` |
| `select-item` | one entry of that list |
| `combobox-content` | the open list of suggestions under a search box, a layer at the end of `<body>` |
| `combobox-group` | one section of it, named by its heading where it has one |
| `combobox-item` | one entry of a section; `data-highlighted` on the one the box announces, `data-state` `checked` or `unchecked` where it can be checked |
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
| `data-state="…"` | `idle`, `loading`, `error`, `empty`, `submitting` | `page`, `data`, `listing`, `form`, `filters`, `component`, `action`, `row-action`, `button`, `markdown`, `chat` |
| `data-invalid="…"` | `true`, while what it holds is refused; the control inside carries its own | `field`, `picker` |
| `data-dirty="…"` | `true`, while it holds input that is not saved | `form` |
| `data-compact="…"` | `true`, while the viewport is below the application's `compactBelow` | `app` |
| `data-surface="…"` | `dialog`, `drawer`, `popover`, `inline`, `panel`, `page`, `confirmation` | `surface` |
| `data-side="…"` | `start`, `end`, `top`, `bottom`: the edge a drawer or a panel sits at, the side of its control a popover opens on; `start` or `end` for the side of its content a filter bar's controls sit at, under `data-placement="aside"` only; `start` or `end` for the side of the page a layout's aside sits at, on `app` while it stands beside `main`; `start` or `end` for the side of its content a split view's aside sits at, and the side an aside is drawn at | `app`, `surface`, `filters`, `aside`, `split` |
| `data-placement="…"` | `above`, `aside`, `collapsible`, `overlay`: where the bar's controls sit now — its compact placement's below the application's `compactBelow` | `filters` |
| `data-active="…"` | `true`, while one of its filters holds a value | `filter`, `filter-chip` |
| `data-pending="…"` | `true`, while what was entered in a control is not yet applied: typed text not committed, a pause under `apply: typing`, a control changed before Apply under `apply: button` | `filters` |
| `data-size="…"` | `small`, `medium`, `large`, `full` — a dialog's, a drawer's or a panel's; `small`, `medium` or `large` — how wide a card layout's cards are, or a split view's aside | `surface`, `cards-layout`, `aside` |
| `data-frame="…"` | `framed`, `flush`: a split view's aside, or a list layout, drawn as a bordered panel of its own spaced from its neighbours, or with no frame and no gap, set against its neighbour by a divider | `split`, `aside`, `list-layout` |
| `data-display="…"` | `inline`, `menu`: a record's actions drawn as buttons, or folded into one menu button | `row-actions` |
| `data-embedded="…"` | `true`, on a part that draws a frame of its own (an outer border, radius and background) while it is the direct content of a flush split view's aside or content — a listing's layout counting as its listing — so it draws none, the split's frame being the one panel | `chat`, `list-layout`, `table-frame`, `tree-layout`, `calendar-grid` |
| `data-button="…"` | `text`, `icon`: a `link` node drawn as a button, by its text or by a glyph, absent on a link drawn inline; how a `command` or a `button` is drawn | `link`, `command`, `button` |
| `data-command="…"` | `chat.exportTranscript`, `chat.copyTranscript`, `chat.stop`, `chat.newConversation`: the command a `command` part runs, so a look can choose its glyph | `command` |
| `data-fill="…"` | `true`, while the part [fills](#filling) the room it is in | `app`, `main`, `page`, `box`, `stack`, `columns`, `text`, `badge`, `link`, `image`, `svg`, `value`, `time`, `list`, `bar`, `command`, `button`, `data`, `listing`, `form`, `action`, `filters`, `component`, `chat`, `split`, `aside`, `split-content`, `markdown`, `navigation`, `tabs`, `tab-panel` |
| `data-record="…"` | `true`: a link drawn from a record's own content — a layout's content, a column's or value's `href` — and never from a relation's label, an action's answer or a form; absent otherwise | `link` |
| `data-selected="…"` | `true`, while a link the record draws leads to where the viewer is: the current location, with the same address and query; absent otherwise | `table-row`, `list-item`, `card`, `board-card`, `calendar-event`, `timeline-bar`, `tree-item` |
| `data-align="…"` | `start`, `center`, `end` — a popover's, along its side; a table column's alignment | `surface`, `markdown-table-header-cell`, `markdown-table-cell` |
| `data-modal="…"` | `true`, `false` — a dialog's or a drawer's | `surface` |
| `data-sorted="…"` | `asc`, `desc` | `table-header-cell`, `listing-sort-option` |
| `data-width="…"` | `contained`, `full`: on `page`, how wide the page's content is drawn, as its page document says — the page's own `width`, else the application's `pageWidth` — the last page's while the next loads, absent on a path no page declares; on `header` and `footer`, how wide its content is drawn — the layout's `width`, else the application's `pageWidth` — the same on every page | `header`, `footer`, `page` |
| `data-actions="…"` | `inside`, `outside`: where the composer's buttons sit | `chat-composer` |
| `data-role="…"` | `user`, `assistant`: who wrote a message | `chat-message` |
| `data-status="…"` | `running`, `done`, `failed` — a tool call's; `pending`, `approved`, `rejected` — an approval's; `uploading`, `failed` — an attached file's | `chat-tool`, `chat-approval`, `chat-attachment-item` |
| `data-level="…"` | `1` to `6`: a heading's depth | `markdown-heading` |
| `data-token="…"` | `comment`, `string`, `number`, `keyword`, `constant`, `function`, `type`, `operator`, `punctuation`, `property`, `variable`, `inserted`, `deleted` — what a highlighted run of code is | `markdown-token` |
| `data-style="…"` | the node's or the rule's style names, space-separated | wherever a style applies |

Five parts of the renderer's own carry `data-state` with values of their own,
and every control carries the states the [controls
contract](controls-abi.md#states) lists for it — `open` / `closed` on a list
or an overlay, `on` / `off` on an option, `checked` / `unchecked` on a
checkbox. The attribute is the same; the part says whose value it holds, so
always select a state together with its part — `[data-state="error"]` alone
is safe, `[data-state="closed"]` alone matches a closed choice control and a
folded filter bar alike.

**The current location** is marked on the links the renderer draws, not by a
part of its own: every link to an address under the application's mount —
`link`, `picker-chosen`, `nav-item`, a `menu` node's items, a value or a column
shown as a link, a related record's label — carries `aria-current="page"` while
it leads to where the viewer is. Select `[data-telo-part="link"][aria-current="page"]`
for one, and `[data-selected]` on a record part for a record that draws such a
link. An address leads to where the viewer is when its path equals the current
path exactly (the fragment is ignored) and its query equals the current query
with every `_telo*` parameter set aside: key order is free, each key's values
are compared in order, and an absent key is absent. A parameter the application
did not write, such as a page number a link does not carry, therefore unmarks
the link. A link to an `https:`, `http:` or `mailto:` address is never
current, and a navigation `page` entry stays current by its path alone.

| Values | On |
| --- | --- |
| `open`, `closed` | `filters-bar`, `filter-chip`, `chat-reasoning` |
| `open`, `collapsed`, `compact` | `split` |
| `open`, `rail`, `compact` | `aside` |

`filters-bar` carries `open` / `closed` only in a collapsible bar, a
`filter-chip` is `open` while its popover is; a `chat-reasoning` is `open` while its body is shown. The element a control opens
from — `filters-add`, an icon button — carries no state of the control's: its
list's is on `menu`, its tooltip's on `tooltip`.

An `action` is `idle`, `submitting` while its operation runs, and `error` once
its record or the operation was refused. A `row-action` carries `data-state`
only while its own operation runs — `submitting`. A listing takes no press of
a record while that record's last is pending, so for as long its `row-action`
and `row-delete` are `disabled`, the pressed one alone carrying the state;
every `row-action` is disabled while a record is being deleted, too. A
`listing` is `loading` until its reads first answer, `error` when one failed,
`empty` when none holds a record, and `idle` otherwise.

`data-style` is a space-separated list, so match one name with `~=`. A
record's element — a `table-row`, `list-item`, `card`, `board-card`,
`calendar-event`, `timeline-bar` or `tree-item` — carries the listing's
`rowStyle`, a cell its column's `style` (a `list` node's `table-row` and
`table-cell` likewise carry its `rowStyle` and its column's), and a confirmation's
`submit` — deleting a row, discarding unsaved input — carries `danger`; the
`submit` of a row operation's confirmation carries none.

A surface carries only the attributes its kind has: `data-side` on a drawer, a
popover and a panel, `data-size` on a dialog, a drawer and a panel,
`data-align` on a popover, `data-modal` on a dialog and a drawer. On `surface`
these hold what the application declared; a tooltip and a choice list carry a
`data-side` and a `data-align` of their own, set by the primitive to where it
placed them.

A `text` node styled `heading` is an `h2`, and `subheading` an `h3`.
