# Nodes

A page is a tree of nodes. A node is plain data with a `type`; the shape is
`Ui.Node`, and a kind takes one with `$ref: "telo://Ui/Node"`. The `type`
written selects the node's shape statically, so `telo check` types the
expressions inside it against that shape alone; a `type` written as an
expression selects nothing.

| `type` | Fields | Is |
| --- | --- | --- |
| `box` | `children` | a group |
| `stack` | `children` | its children one under another |
| `columns` | `children` | its children side by side |
| `text` | `text` | a run of text |
| `badge` | `text` | a short label |
| `link` | `text`, `href`, `button?` | a link, inline or drawn as a button |
| `menu` | `text`, `items` | a button opening a list of links |
| `tabs` | `tabs`, `address?` | content under tabs, one tab at a time |
| `image` | `src`, `alt` | an image |
| `svg` | `markup`, `alt` | SVG markup, drawn as an image |
| `value` | `value`, `text?`, `href?` | one value of a data scope, presented as its schema says |
| `time` | `value`, `relative?` | a [date or a date-time](#times), relative to now or absolute |
| `list` | `rows`, `columns`, `heading?`, `rowStyle?` | the rows of a list one answer holds, a column per value |
| `markdown` | `value`, `annotations?` | [Markdown text](#markdown), with a control on each item the server names |
| `button` | `action`, `inputs`, `confirm?`, `prompt?`, `enabled?`, `button?` | a [button running an action](#buttons) with inputs bound from the data in scope |
| `bar` | `start?`, `center?`, `end?` | a [bar](#bars): nodes at its start, its centre and its end |
| `command` | `command`, `text`, `button?` | a button running a [command](#commands) of the place it is written in |
| `composite` | `ref` | a [composite](composite.md): a `!ref`, or an inline declaration |
| `pane` | `ref` | a [pane](pane.md) — a piece of chrome such as a navigation bar: a `!ref`, or an inline declaration; replaced by the node it answers |

Every node also takes:

- `style` — one name from the style list, or a list of them; every node but
  `tabs`, whose look is its theme's, and `pane`, whose node is the pane's.
- `when` — a boolean, `true` when left out: whether the node is **delivered**.
  It is evaluated on the server — per request on a page's own nodes (where it
  may read `request`), once at creation inside a composite — and a node whose
  `when` is false is left out of its parent: it is not sent and holds no state.
  A `pane` follows the same rule: invoked per request with the request where
  the tree is delivered per request, once — with none — inside a composite.
- `shown` — a [condition](conditions.md): whether a delivered node is
  **drawn**. It is read in the browser over the roots the place it is written
  binds, and content it hides keeps its state and starts no request. Both keys
  may be present.
- `fill` — `true` stretches the node to the bottom of the room it is in; see
  [filling the room](#filling-the-room). Refused on a menu item.

## Bars

A `bar` lays out a row in three regions — `start`, `center` and `end`, each a
list of nodes — the shape of an application bar, a card's header or a listing's
toolbar. The regions are logical, so a right-to-left page mirrors them, and
`center` stays centred however wide the sides are. Below the renderer's
breakpoint the regions wrap. A renderer receives all three, `[]` for one not
written.

```yaml
- type: bar
  start: [{ type: text, text: Orders, style: heading }]
  end: [{ type: link, text: New order, href: /orders/new, button: { kind: Ui.TextButton } }]
```

## Commands

A `command` node is a button that runs a command the place it is written in
offers. `command` is an [accessor](https://telo.run/docs/extend/accessor-fields)
naming one: a chain to a `Ui.Command` member of a root that place binds — a
[chat's header](chat.md#the-header) binds `chat`, whose members are
`exportTranscript`, `copyTranscript`, `stop` and `newConversation`. `text` is
the button's text (its accessible name and tooltip when drawn as a glyph alone),
and `button` a [`Ui.ButtonDisplay`](chat.md#buttons-as-icons), `Ui.TextButton`
when omitted; an `Ui.IconButton` with no `icon` draws the look's glyph for that
command.

```yaml
- type: command
  command: !cel "chat.exportTranscript"
  text: Export
  button: { kind: Ui.IconButton, icon: { kind: UiLucide.Icon, name: download } }
```

A `Ui.Command` is `{ offered, enabled }`: a command that is not offered is not
drawn, one that cannot run now is drawn disabled, and a condition may read
either (`{ at: !cel "chat.stop.enabled", matches: { const: true } }`). A root
read where the place binds none is `CEL_UNKNOWN_IDENTIFIER`, a command it does
not offer `CEL_UNKNOWN_FIELD`, and a chain to something that is not a command
`CEL_TYPE_ERROR`; a fixed value, which no type check can refuse, is
`ERR_UI_COMMAND_UNRESOLVED` when the node is resolved.

## Filling the room

`fill: true` on a node stretches it to the bottom of the room it is in, the
author writing it only on the node meant to reach the bottom: `ui` marks every
node between it and the room's edge as filling too, after every `when` is
decided and every composite placed (so `fill` on a composite moves onto the node
it provides, as `style` and `shown` do).

- **The room** is the page — the viewport under the application's header and
  above a tab bar — or a surface's body, and inside a listing a record. A page
  fills exactly when one of its delivered nodes fills: it then no longer scrolls
  as a whole, and its other nodes keep their natural height.
- **Sharing.** A filling node takes the height its container leaves after its
  other children; filling siblings share it equally.
- **Passing on.** A filling node holding a filling node passes the room on and
  never scrolls itself; its minimum is its content's.
- **The end of the chain** — a filling node holding none — scrolls inside
  itself, or where its renderer says (a chat's transcript, a split view's
  aside). Its minimum is its renderer's (a chat's `24rem`), else none.
- **Below the minimum** the room scrolls, never a node inside it.

A box drawn on its own — a surface's form, a listing's empty tree, an action's
answer, a row action, a menu's items, a split view's actions, a chat's header —
is decided inside itself and fills nothing around it. A card or board layout
gives one row's records one height; a list record is as tall as its content.

## Links drawn as buttons

A `link` is inline text unless it names a `button`, a
[`Ui.ButtonDisplay`](chat.md#buttons-as-icons) — `{ kind: Ui.TextButton }` or
`{ kind: Ui.IconButton }`. It is then drawn as a button-shaped anchor, never a
`<button>`: it is still an `<a>` with the address, so it opens in a new tab and
is announced as a link. The look of the button is the node's `style`: `accent`
is an emphasised button, no style a neutral one.

```yaml
- type: link
  text: New conversation
  style: accent
  href: { path: !ref assistant }
  button: { kind: Ui.IconButton, label: shown, icon: { kind: UiLucide.Icon, name: plus } }
```

An `Ui.IconButton` with no `icon` draws the look's `go` glyph (an arrow, mirrored
on a right-to-left page); with `label: hidden` the `text` is the accessible name
and a tooltip. `button` on any other node type, and on a menu item, is a
`SCHEMA_VIOLATION`. A renderer receives `button` on every `link` node, `null`
for an inline link.

## Menus

A `menu` is a button labelled `text` that opens its `items`, each a `link`
node — `text`, `href` and the keys every node takes:

```yaml
- type: menu
  text: Language
  items:
    - { type: link, text: English, href: "/api/lang?set=en", style: strong }
    - { type: link, text: Polski, href: "/api/lang?set=pl" }
    - { type: link, text: Beta features, href: /beta, when: !cel "variables.beta" }
```

Choosing an item follows its `href` exactly as clicking that link would: a
page the application declares is a move within it, anything else an ordinary
load, under the same [address rule](#addresses). An item is the current choice
when its address [leads to where the viewer is](#the-current-location) or its
`style` holds `strong`, and a renderer marks it so. Each item is
delivered by its own `when` and drawn by its own `shown`; a menu none of whose
items is delivered is left out, as a node whose `when` is false is. A menu
works anywhere a node does.

## Tabs

A `tabs` node draws its `tabs` as a row of tabs and the chosen one's
`children` under them. Each tab is a `text` and the nodes it holds, and is
delivered by its own `when`:

```yaml
- type: tabs
  address: { name: section }
  tabs:
    - text: Summary
      children:
        - { type: composite, ref: !ref summaryView }
    - text: Audit
      when: !cel "'x-role' in request.headers && request.headers['x-role'] == 'admin'"
      children:
        - { type: composite, ref: !ref auditView }
```

The first tab is chosen until another is. With `address: { name }` the chosen
tab is part of the page's address, as an [addressed surface](surfaces.md) is —
the query key `_telo.open.<name>` holds the tab's key, the slug of the text it
was written with (`Audit` → `audit`, a later tab of the same text `audit~2`;
see [entry keys](https://hub.telo.run/module/oci/ghcr.io/telorun/ui-react/)), so a tab gated off
by `when` moves no other's — so a reload or a shared link opens that tab
again, and the browser's back button returns to the tab before; without one
the choice lasts as long as the page is shown. A key naming no delivered tab
chooses the first. Only the chosen tab's nodes are drawn: another tab's are drawn anew,
and start their requests anew, when it is chosen. A `tabs` node none of whose
tabs is delivered is left out, as a node whose `when` is false is.

## Values and lists

A `value` and a `list` name what they draw with [accessors](https://telo.run/docs/extend/accessor-fields)
over the roots in scope — `data` inside a [`Ui.Data`](data.md), `query` where
query parameters are declared, `params` — the page's [path
variables](page.md#params) — wherever a page's nodes are, `error` in a reader's or an action's `failure`,
`result`, `input` and `values` in an [action's answer](action.md#the-answer),
`row` in a list column and its row actions, and in a markdown node's
[annotations](#markdown):

```yaml
- type: value
  value: !cel "data.email"
- type: list
  heading: Files
  rows: !cel "data.files"
  columns:
    - value: !cel "row.name"
    - header: Open
      value: !cel "row.url"
      shown: { at: !cel "data.signedIn", matches: { const: true } }
```

A value is presented as its schema says: a `format: uri` / `uri-reference`
string is a link, held to the address rule below, drawn as `text` when that is
given; a value with an `href` is drawn as a link to that [address](#addresses),
the presented value as its text; a date and a time as a date; a boolean as yes or no. A `list` draws the
rows of one answer and is bounded by it — it never pages; a set that grows
without limit is a [`Ui.Listing`](listing.md) over the collection contract. A
column's header defaults to the `title` of the value it reads, its `href` is an
[address](#addresses) the cell links to over `row` and the roots the list is
drawn under, and its `shown` reads the roots the list is drawn under, never
`row`. `row` is typed as an
element of what `rows` names, so `row.nmae` is refused by `telo check`.

A column is a value unless it says `type: time`: `{ type: time, header?, value,
relative?, href?, shown?, style? }` draws its value as a [`time` node](#times)
does, and takes every other member a value column takes.

A list's `rowStyle` and a column's `style` are [style rules](#style-rules) over
`row`, as a listing's are: the first styles each row, the second each cell of
its column.

A list's `rowActions` offers an action on every row, each entry a
[`Ui.BoundAction`](action.md#bound-actions) whose `inputs` and `enabled` read `row`
and the roots the list is drawn under; a pressed one draws its action's answer
in place of its button, which lasts as long as the answer the list is drawn
from. `rowActionsDisplay` (`auto`, the default, `inline` or `menu`) says how
they are drawn, as a [listing's](listing.md#how-the-actions-are-drawn) are —
buttons, or one menu button — here with the row actions alone, a list having no
edit or delete.

## Times

A `time` draws a date or a date-time. `value` is an
[accessor](https://telo.run/docs/extend/accessor-fields) to a string of
`format: date` or `date-time`; `relative: true` draws it relative to now in the
viewer's language ("3 hours ago"), the exact time as its tooltip and as the
element's machine-readable time, and `relative: false`, the default, draws the
absolute date or time in the viewer's language and time zone:

```yaml
- { type: time, value: !cel "data.plan.latestRevision.createdAt", relative: true }
```

A chain to a string with no such format is `CEL_TYPE_ERROR` (`'data.plan.title'
is a string with no format; the field takes a string of format date or
date-time`), and so is any other type. A tree `telo check` did not judge — a
reader in an imported library — is refused when it is first read
(`ERR_UI_TIME_VALUE_NOT_DATE`). A value that turns out not to be a date at run
time is drawn as plain text. `relative` belongs to `time` alone: on a `value`
node it is `SCHEMA_VIOLATION`.

## Markdown

A `markdown` node draws Markdown text — CommonMark with tables and task lists,
raw HTML drawn as text, links and images held to the [address
rule](#addresses). `value` is an
[accessor](https://telo.run/docs/extend/accessor-fields) to a string (a chain to
anything else is `CEL_TYPE_ERROR`), or a fixed text.

`annotations` puts a control on each item the server names in the text. Which
blocks are items, and their IDs, are the server's grammar: the node parses
none.

| Member | |
| --- | --- |
| `rows` | required: an accessor to a list, each element being `row` |
| `line` | required: an accessor over `row` to the 1-based source line starting the item, an integer |
| `count` | an accessor over `row` to an integer, shown on the control as a badge |
| `action` | required: a [`Ui.BoundAction`](action.md#bound-actions) whose `inputs` and `enabled` read `row` beside the roots in scope; the control is labelled with the action's `label` |

```yaml
- type: markdown
  value: !cel "data.plan.latestRevision.body"
  annotations:
    rows: !cel "data.plan.latestRevision.items"
    line: !cel "row.line"
    count: !cel "row.count"
    action:
      inputs: { id: !cel "params.id", revision: !cel "data.plan.latestRevision.seq", item: !cel "row.id" }
      prompt: true
      action: !ref comment
```

`row` is typed as an element of what `rows` names, so `row.lnie` is
`CEL_UNKNOWN_FIELD` (`not defined (available: id, line, count)`). The control is
drawn on the block containing `line` — a list item for an item's line, a
heading for a heading's — two annotations on one block drawing two controls in
order, and an annotation whose line is past the text is drawn after it, so
none is lost. A pressed control draws its action's answer as a row action does.

## Buttons

A `button` runs a [`Ui.Action`](action.md) with its inputs bound from the data
in scope — the page's `params` and `query`, and the roots of the tree it sits
in, `data` inside a reader. Its members are a
[`Ui.BoundAction`](action.md#bound-actions)'s, plus `button`, a
[`Ui.ButtonDisplay`](#links-drawn-as-buttons) (a text button when left out),
and it is labelled with the action's `label`:

```yaml
- type: button
  inputs:
    id: !cel "params.id"
    decision: approve
    revision: !cel "data.plan.latestRevision.seq"
  prompt: true
  action: !ref decide
```

`inputs` is judged against the action's `inputModel` as a row action's is: a
key the action does not take, a member the data does not declare, or a value of
the wrong type is refused by `telo check`, and so is a required input left
unbound unless `prompt: true`; inputs that make no record of the input model are
refused again when the node is first read (`ERR_UI_BOUND_ACTION_INPUTS_INVALID`).
`prompt: true` opens a dialog asking for the action's fields the inputs do not
bind, where the person completes the record — see [bound
actions](action.md#bound-actions). A pressed button draws its action's answer in
place of itself and its `failure` beside it, or in the open dialog; it takes no
press while one is pending.

## Texts

Every text a node shows — a `text`, a `badge`, a link's `text`, a menu's
`text` and each of its items', an `alt`, a
value's `text`, a list's `heading` and a column's `header` — is a
`Ui.BoundText`: a [`Text`](https://telo.run/docs/extend/text-records) written in
the module's `lang:`, or `{ text, values }` where the text names values the
page reads:

```yaml
- type: text
  style: heading
  text:
    text: { plural: n, cases: { one: "{$n} unpaid invoice", other: "{$n} unpaid invoices" } }
    values: { n: !cel "data.unpaid" }
```

Each value is an [accessor](https://telo.run/docs/extend/accessor-fields) over
the roots in scope, read in the browser, so the words are composed in the page
and translated as one text — never assembled by the backend. A placeholder the
values do not bind, and one written in a plain text, are refused by `telo
check`. See [Texts and translation](texts.md).

Each `type` is a closed shape: a key it does not take is an error naming the
key, and a `type` outside the list is an error listing the valid ones.

Spacing is not a field — no gap, alignment, width or image size. How nodes are
spaced is the renderer's styling contract. A button runs an operation only as a
[`button` node](#buttons), a [`Ui.Action`](action.md) or what a listing offers
on its records; a `menu`'s button only opens its links.

## Addresses

- An **address** is where a link leads: a literal string, or
  `{ path, pathParams, queryParams }`. It is the `href` of a `link` — a menu
  item's included — and of a `value` node, a `list` column, a
  [`Ui.TableLayout`](listing-layouts.md) column, and a relation of a
  [presentation](collection-presentation.md#relations) or a
  [`Ui.CollectionOptions`](field-kinds.md). `Ui.NavigationItem.href` stays a
  string; `image.src` stays literal. A request is addressed the same way, as a
  `Ui.RequestTarget` (a reader's [`source`](data.md)).

  | Member | |
  | --- | --- |
  | `path` | a literal app-relative path, or starting with `https://`, `http://` or `mailto:`, with `{name}` for a whole segment — after the host, for an absolute address; a path into data holding a whole address (`!cel "row.url"`), used as it is; or a `!ref` to a `Ui.Page`, which is that page's `path` |
  | `pathParams` | the value of each `{name}`: a path into a root in scope, or a fixed value, a string or an integer; a path whose value may be null is accepted, and null leaves the address unresolved |
  | `queryParams` | the parameters appended, in the order written: a path into a root in scope, or a fixed value — a string, an integer, a number, a boolean, or a list of them, which repeats its key; the value may be null, and null is left out |

  ```yaml
  - type: link
    text: Item
    href:
      path: "/items/{id}"
      pathParams: { id: !cel "query.id" }
      queryParams: { tab: details }
  - { type: link, text: Home, href: { path: !ref home } }
  - { type: link, text: Docs, href: /docs }
  ```

  A bare string is a literal path with no `{` or `}`. Quote a template in flow
  style: `{` starts a mapping in YAML. The address binds no root: the place it
  is written does — a page's `query` and `params`, a reader's `data`, a list's and a
  listing's `row`, a relation's related `row` — so `row.nmae` is refused by
  `telo check` like any other read. Every `{name}` has exactly one entry in
  `pathParams` and every entry names a `{name}` (`PATH_PARAMETER_UNBOUND`,
  `PATH_PARAMETER_UNUSED`, with a `!ref` checked against the page's own `path`,
  its [variables](page.md#path-variables) included);
  a path read from data is never expanded, so it takes no `pathParams`.
  [Path templates](https://telo.run/extend/path-templates) has the rules.

  An address is **not evaluated per request**: `href: !cel "request…"` is
  `CEL_UNKNOWN_IDENTIFIER`. A link that differs by request is two `link` nodes
  with a `when` each.

  A renderer expands it one way, pinned by `conformance/addresses.json`:
  each segment value is percent-encoded so only unreserved characters
  (`A-Z a-z 0-9 - . _ ~`) stay — `a/b` is `a%2Fb`, `..` is `%2E%2E` — and an
  empty, absent or null value leaves the address unresolved
  (`ERR_UI_ADDRESS_UNRESOLVED`, `data.parameter` naming it; a link is then drawn
  as text). Query parameters follow in declaration order, form-urlencoded, a
  null value and an empty list left out; they come after a data path's own
  query and before its fragment. The result is held to the address rule below.
- **A `*` or `**` segment is refused** in every address and request target
  (`SCHEMA_VIOLATION`, by `telo check` and again at creation): a whole segment
  that is `*` or `**` belongs to a [`refreshes`](action.md#after-a-success)
  entry alone, which takes a `Ui.RefreshTarget` — a request target whose
  literal path may hold them.
- What a renderer receives is `{ path, pathParams, queryParams }` with every
  member present, each a binding: a literal string is
  `{ path: { value }, pathParams: {}, queryParams: {} }`, a page reference
  `{ value: <that page's path> }`. `@telorun/ui` exports `addressSpec` to build
  one and `expandAddress` to resolve one.
- `image.src` is an app-relative path or starts with `https://` or `http://`.
  `alt` is required and may be empty for a decorative image.
- An app-relative path is `/` followed by anything other than `/` or `\`,
  with no control character (a tab, a line break) anywhere in it.

  | Written | |
  | --- | --- |
  | `/`, `/done`, `/a//b` | app-relative |
  | `//host/x`, `/\host/x` | refused: a browser reads it as another host |
  | `/` followed by a tab, then `/x` | refused: a browser drops the tab and reads `//x` |

  It is one exported shape, `Ui.AppRelativeReference`, named by every field
  holding an address — a navigation entry's `href`, a page's `path`, an
  address's and a request target's `path`, an action's `request.target`,
  `onSuccess.navigate` and `refreshes`, and a collection source's `basePath`
  and its template's `path` —
  so a kind of another module holding one references it too. A literal one is
  refused by `telo check`; a computed `src` that breaks it is replaced by an
  `error` node for that request, and an address read from data that breaks it is
  drawn as text.
- An app-relative path is the application's own: a renderer mounted under a
  prefix resolves every one under that prefix — a `link`'s `href`, an
  `image`'s `src`, a collection source's `basePath` and an action's
  `request.target` alike.
- `svg.markup` is never inserted into the page. A renderer draws it as an
  image, so nothing in it can run or reach the document.

## The current location

A renderer marks the link that leads to where the viewer is, with no key to
write: every link to an address under the application's mount that it draws —
a `link` node (a button-shaped one too), a `menu` item, a `value`'s `href`, a
column's `href`, a related record's label, a value the model calls a
`uri` — is `aria-current="page"` while its path equals the current path
exactly (the fragment ignored) and its query equals the current query. The
renderer's own parameters (`_telo*`) are set aside from both; key order is free,
each key's values are compared in order, and an absent key is absent. So on `/`
a link to `/` is current and a link to `/?conversation=abc` is not, and on
`/?conversation=abc` only the second is. A parameter the application did not
write — a page number the links do not carry — unmarks a link. An `https:`,
`http:` or `mailto:` address is never current.

A record of a `list` node, a table or a listing's layout whose spec draws such
a current link is the *selected* record: a renderer marks it, and the layout
contract's `selected` is true. A related record's label and a row action's
answer never select it, and a component layout, which draws its own links, is
never handed `selected: true`. A [navigation](navigation.md#entries--uinavigationitem) `link`
entry follows the same rule, and a `page` entry stays current by its path alone.
The marking follows the address as it changes, a navigation or a write that
replaces the query included, with no reload.

## Styles

A closed list. A style says what a node means; the theme decides how that
looks.

| Style | Meaning |
| --- | --- |
| `title` | the page's title (the level-1 heading element on `text`); a page draws its own, since no heading is drawn for its `title` |
| `heading` | a section heading (a level-2 heading element on `text`) |
| `subheading` | a heading below it (level 3) |
| `muted` | secondary |
| `strong` | emphasised |
| `accent` | in the accent colour |
| `danger` | an error or a destructive thing |
| `warning` | needs attention |
| `success` | went well |

A theme token name is never a style value.

## Style rules

Where a style depends on data — a row, a cell — it is a rule, not a callback:

```yaml
rowStyle:
  by: !cel "row.status"
  cases:
    overdue: danger
    done: [muted, strong]
  default: strong
```

`by` is an [accessor](https://telo.run/docs/extend/accessor-fields): a plain
chain into the row, or a fixed value. A case key is matched against the plain
text of the value — `true`, `false`, a number's digits, a string as it is. A
null value takes `default`; a value no case names takes `default` too.

## What a renderer receives

`Ui.SpecNode` is the same vocabulary after resolution: every `when` decided
and gone — a menu's items and a `tabs` node's tabs included, so a `menu` carries at least one item and `tabs` at least one tab — every `shown` carried as written (`{ at, matches }`, `at` a binding),
every composite replaced by the node it provides (`listing`, `form`, `action`,
`filters`, `data`, `component`), every pane by the node it answers (left out
when it answers none — there is no `pane` node on the wire), and `error` for a
node that could not be produced. Every node carries `fill`, `true` exactly where it or a node in the
room it passes on was written filling. A `value` and a `time` node carry
`present` — what the schema it reads says (`type`, `format`) — and each `list`
column its `header` and `present`, all resolved on the server, a time column
`type: time` and a value column no `type`; a `value` node and a value column carry `labels`, the label of
each value an enumeration offers (`[]` when none), and a `time` node and a time
column `relative`, `false` when not written. Every text is a text record, a
`{ text, values }` text is the record with its `values` beside it, and a text
`ui` fills itself is a keyed text `{ set: Ui.Translations, key }` — see
[what a renderer receives](texts.md#what-a-renderer-receives). A composite placed with a `shown` of its own around a
provided node that has one is wrapped in a `box` carrying the placement's, so
both must hold. It carries no resource name. Row-bound values in it are **bindings** — `{ root, path }` for a
chain, `{ value }` for a literal — which a renderer resolves by following the
path; no expression engine runs in the browser.

**A node carries every presentation member, declared or not.** A `listing` node's
`create` and `edit` are each `{ form, surface, afterSubmit, unsaved }`, all four
present: `form` the form node, `surface` a [`Ui.SurfaceSpec`](surfaces.md#what-a-renderer-receives)
with every member its kind has, `afterSubmit` and `unsaved` as declared or
defaulted. The defaults are this module's, filled before the node is provided,
so two renderers cannot disagree about them and none carries a table of its
own.

A `listing` node always carries `query` (its declared parameters, empty when
none), `rowActions` (an empty list when the listing declares none),
`rowActionsDisplay`, `sort` (`{ sortable, initial }`), `show` (`{ count }`),
`relations`, `empty` and its `layout`; a `list` node always carries
`rowActionsDisplay` and carries `rowActions` when it declares them, and
`rowStyle` and a column's `style` — each `{ by, cases, default? }`, `by` a
binding — when declared. A bound action is
`{ action, inputs, confirm?, prompt?, enabled? }`: `action` is the action's
own node, `inputs` maps each input property to a binding, `confirm` is present
exactly when the entry asks a question, `prompt` — `{ fields }`, the fields its
dialog enters — exactly when the entry declares `prompt: true`, and `enabled`
exactly when the entry declares one. A `button` node is a bound action's
members plus `button` (a `Ui.ButtonDisplaySpec`, `{ type: text }` when none is
written), `style?`, `shown?` and `fill`. A `markdown` node is `{ value,
annotations?, style?, shown?, fill }`, `value` a binding and `annotations`
`{ rows, line, count?, action }` exactly when written, the first three bindings
and `action` a bound action.

An `action` node always carries its input model, its `request` (method, target and the consumed input properties), the
button's text, one `{ property, label, shown? }` per field, its `failure` tree
(the default filled in), `onSuccess` (`refreshes` empty when none),
`concurrency` and `clearAnswerOn`; `answer` (the output model), `result` and
`enabled` are present exactly when declared. See
[what an action provides](action.md#what-a-renderer-receives). A `data` node is
described in [what a reader provides](data.md#what-a-renderer-receives).

A `filters` node likewise carries its whole policy: `placement` (a
[`Ui.FilterPlacementSpec`](filter-placement.md#what-a-renderer-receives), which
holds `show`, `controls` and `summary`), `apply`, `state` (`{ address, store, key? }`, `store` a
[`Ui.StateStoreSpec`](state-store.md#what-a-renderer-receives), `key` present
exactly when the bar declared `state`) and `presets` — an empty list when
there are none, a preset carrying `search` only when it sets one. `search`
(`{ pinned, default }`, `default` null when none is written) is present exactly
when [the bar has a search](filters.md#search). Each of its `fields` carries `pinned` and `control`, and
`default` only when one is declared. A default and a preset value are always a
list, whatever was written: one value is a list of one, a [value relative to
now](filters.md#values-relative-to-now) a list of one `{ unit, offset }`.

## Nodes a renderer receives

Composites and panes provide nodes of the `Ui.SpecNode` shape, which has four
that are not written by hand in a page's tree:

| `type` | Members | Is |
| --- | --- | --- |
| `chat` | `spec`, `basePath`, `header`, `placeholder`, `starters`, `show`, `buttons`, `composer`, `conversation`, `refreshes`, `style?`, `shown?` | the node [`Ui.Chat`](chat.md) provides, every member present |
| `split` | `aside` — every member of a [`Ui.Aside`](split-view.md#the-aside) present — `content`, `style?`, `shown?` | the node [`Ui.SplitView`](split-view.md) provides |
| `navbar` | `title?`, `start`, `end`, `navigation`, `placement`, `shown?` | the node [`Ui.Navbar`](navigation.md#uinavbar) answers, every member but `title` present |
| `navigation-column` | `navigation`, `state`, `shown?` | the node [`Ui.NavigationColumn`](navigation.md#uinavigationcolumn) answers, `state` `null` when the open groups are kept in memory |
