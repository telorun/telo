# UiReact.App

An application of pages. A `Telo.Mount`: list it under an `Http.Server`'s
`mounts`.

| Field | | |
| --- | --- | --- |
| `title` | required | the application's name, a text shown in its header and as the document title |
| `words` | required | the [`Ui.Words`](../../ui/docs/texts.md#the-renderers-own-words) the renderer draws on its own — `!ref Ui.words` for English |
| `translator` | | an [`I18n.Translator`](../../i18n/README.md): every text is looked up in its catalogs |
| `lang` | | the language a request is served in: a language tag, or an expression over `request` |
| `theme` | required | one [`UiReact.Theme`](theme.md): `!ref UiReact.defaultTheme`, a theme another module publishes, or one of your own |
| `tokens` | | your brand: one [`Ui.DesignTokens`](../../ui/docs/design-tokens.md), or a list of `{ tokens, when? }` |
| `stylesheets` | | your own stylesheets, as host paths: `!module-path ./ui.css` |
| `compactBelow` | `40rem` | the viewport width below which every surface's `compact` replacement applies: a CSS length in `px`, `rem` or `em` |
| `pageWidth` | `contained` | how wide a page's content is drawn when the page declares no `width`: `contained` or `full` — see [Page width](#page-width) |
| `header` | | `{ start?, end?, width? }`: nodes of your own in the header, before the title and after the navigation, and how wide its content is drawn — see [Header](#header) |
| `pages` | required, at least one | the [`Ui.Page`](../../ui/docs/page.md)s the application routes to, written in place or `!ref` |
| `navigation` | | the [`Ui.Navigation`](../../ui/docs/navigation.md) tree and how it is drawn — see [Navigation](#navigation) |

## Pages

```yaml
pages:
  - kind: Ui.Page
    path: /
    title: Todos
    children:
      - { type: text, text: Open work, style: heading }
      - { type: composite, ref: !ref todos }
  - !ref reports
  - !ref Billing.invoices      # a page a library exports
```

- Each entry is a [`Ui.Page`](../../ui/docs/page.md): its `path`, `title`,
  `query` and `children`. The application invokes it for every request to its
  path; the page's composites are resolved once, when the page is created.
- Two pages at one path are refused: `RESOURCE_RULE_VIOLATED` with
  `data.rule: UI_PAGE_PATH_DUPLICATE` at `telo check`,
  `ERR_UI_PAGE_PATH_DUPLICATE` at creation.
- A page's `query` declares the query parameters its own nodes read; the page
  document carries it, `{}` when none is declared.

### Page width

```yaml
pageWidth: full          # every page fills the room beside the navigation
pages:
  - !ref dashboard
  - kind: Ui.Page
    path: /settings
    title: Settings
    width: contained     # this one keeps the look's measure
    children: [ … ]
```

- A `contained` page's content is drawn no wider than the look's page measure,
  the `width.page` [design token](../../ui/docs/design-tokens.md), and
  centred; a `full` one takes all the room it has.
- A page's own `width` wins; with none, the application's `pageWidth`
  applies; with neither, `contained`. The default is filled by `ui`'s page,
  which the application invokes with its `pageWidth`, and the page document
  carries the result as `width` — so one page listed by two applications can
  be drawn at two widths.
- The `page` part carries it as `data-width`, and the renderer's own layer
  applies the measure (see [the styling contract](styling.md#tokens)): a theme
  sets the measure through `width.page`, never by a `max-width` on `page`.
- The header's content follows the application's width, not the page's — see
  [Header width](#header-width).
- A misspelt value is `SCHEMA_VIOLATION` at `telo check`.

## Navigation

The navigation is a tree of entries naming pages by reference — never by path
— beside links and groups nested to any depth; how it is drawn is a placement.
The whole vocabulary is [`ui`'s](../../ui/docs/navigation.md).

```yaml
navigation:
  items:
    - { type: page, page: !ref home, icon: !ref homeIcon }
    - type: group
      text: Reports
      icon: !ref reportsIcon
      items:
        - { type: page, page: !ref monthly }
        - type: group
          text: Archive
          items:
            - { type: page, page: !ref archive2025 }
    - { type: link, text: Status, href: "https://status.example.com" }
  placement:
    kind: Ui.HeaderNavigation
    compact:
      kind: Ui.OverlayNavigation
      surface: { kind: Ui.Drawer, side: end }
---
kind: UiLucide.Icon
metadata: { name: homeIcon }
name: house
---
kind: Ui.FileIcon
metadata: { name: reportsIcon }
file: !module-path ./icons/reports.svg
```

- With no `navigation`, there is one entry per page, in the order `pages`
  lists them; with no `placement`, the tree is drawn in the header, and below
  `compactBelow` behind a menu button opening a drawer from the start edge.
  Every other default is filled by `ui` (see
  [its defaults](../../ui/docs/navigation.md#defaults)).
- An entry's `when` is evaluated per request over `request`, and the headers
  it reads join the application document's `Vary`. A group none of whose
  entries is delivered is left out.
- An entry naming a page `pages` does not list leads nowhere: it is
  `RESOURCE_RULE_VIOLATED` with `data.rule: UI_NAVIGATION_PAGE_UNROUTED` at
  `telo check`, at that entry however deep, and
  `ERR_UI_NAVIGATION_PAGE_UNROUTED` at creation.
- **In the header** (`Ui.HeaderNavigation`) the tree is drawn in the `nav`
  part by the [`Navigation` control](controls-abi.md#navigation) in a row: a
  group opens as a dropdown, a group inside it as a submenu, and what does not
  fit the row moves under More. The navigation is a landmark named by the
  `siteNavigation` word, under every placement.
- **Behind a menu button** (`Ui.OverlayNavigation`) the header shows the
  `nav-menu` button — first, or last when its surface is a drawer opening from
  the `end` edge — which opens the surface holding the whole tree in a column,
  each group opening in place beneath its button, so several may be open at
  once. Following an entry closes it. The surface's own `compact` applies below the
  breakpoint, and its `address`, when it declares one, keeps it open in the
  page's query.
- **In a sidebar** (`Ui.SidebarNavigation`) the tree is drawn in the
  `sidebar` part, a column beside `main` under the header at the placement's
  `side`, in a column whose groups open in place beneath their buttons —
  several at once, none closed by following a link. With a `rail`, the
  `sidebar-toggle` button — named by the `collapseNavigation` word, or
  `expandNavigation` while collapsed — collapses it to a rail of each
  top-level entry's icon — its first letter when it has none — whose groups
  float their entries beside it, and expands it again. The open groups, each
  by its [key](urls.md#entry-keys), and whether it is collapsed are kept in
  its `store` under `telo.ui:<mount path>:n` (see [what an application
  serves](urls.md#navigation-state)) and read back when the application is
  drawn again. Below `compactBelow` it is replaced by its `compact`: a menu
  button with a drawer from its own side unless another is named.
- **As a tab bar** (`Ui.TabBarNavigation`) the top-level entries are drawn as
  tabs in the `tab-bar` part along the bottom edge — at most `visible`, the
  last being More, holding the rest, when there are more; every tab stays in
  the bar however narrow the screen. A page or a link's tab follows it; a
  group's tab, or More, is a button (`aria-haspopup="dialog"`, expanded while
  its surface is open) opening its entries in the placement's `surface`, in a
  column whose groups open in place, and following an entry there closes
  it. A tab bar is a sidebar's or a header's
  `compact`, or the application's placement at every width.
- The entry of the page being shown carries `aria-current="page"`, and every
  group on the way to it is marked current.
- An entry whose address does not resolve inside the application is left out
  of the tree and drawn as the `error` node `ERR_UI_NODE_INVALID` beside it.

### Icons

An entry's `icon` (a [`Ui.Icon`](../../ui/docs/icons.md)) is drawn as the
`glyph` part before its text — above it in a tab bar, in its place in a rail.
The application reads the icon's file when it starts and serves it under
`_telo/ui/assets/<digest>/<name>` like every other file. The glyph is an empty
`span` whose `--ui-react-glyph` custom property names that address, which the
renderer's layout uses as a mask over `currentColor`: the glyph takes the
colour of the entry's text — the current entry's included — and none of the
file's markup enters the page. A file that is not an SVG, PNG or WebP image is
refused with `ERR_UI_ICON_FORMAT_UNKNOWN` when the application starts.

## Header

The header holds the application's title and the navigation. `header` adds
nodes of your own around them, drawn on every page — the not-found page
included: `start` before the title, `end` after the navigation. Above
`compactBelow` the built-in layout keeps the header to one row — `start`, the
title, the navigation taking the room left, `end` at the inline end — and
below it the header wraps; the default theme then keeps the menu button,
`start`, the title and `end` on one row, and lets the header scroll away with
the page (see [the default theme](theme.md#the-default-theme)). The `header`
slots are the same under every navigation placement. A switch belongs in a
[`menu`](../../ui/docs/nodes.md#menus), which takes one button's room:

```yaml
header:
  start:
    - { type: image, src: /files/logo.svg, alt: Acme }
  end:
    - type: menu
      text: Language
      items:
        - type: link
          text: English
          href: "/api/lang?set=en"
          style: !cel "'cookie' in request.headers && request.headers['cookie'].contains('lang=en') ? ['strong'] : []"
        - type: link
          text: Polski
          href: "/api/lang?set=pl"
          style: !cel "'cookie' in request.headers && request.headers['cookie'].contains('lang=pl') ? ['strong'] : []"
    - type: badge
      text: Staff
      when: !cel "'x-role' in request.headers && request.headers['x-role'] == 'staff'"
```

- Each is a [`Ui.Node`](../../ui/docs/nodes.md), resolved as a page's own
  nodes are: its `when:` — and a menu item's — and leaf values are [evaluated per
  request](#what-is-evaluated-per-request) over `request`, its texts are
  translated, a composite is resolved once when the application starts, and
  the headers its expressions read join the application document's `Vary`.
- A header has no `query`, or any other browser root: a condition or a
  `value` / `list` node in it reading one is `CEL_UNKNOWN_IDENTIFIER` at
  `telo check`.
- The nodes travel in the [application document](urls.md#the-application-document),
  not in a page's; the renderer draws each side in its own part,
  `header-start` and `header-end`, only when it holds a node.

### Header width

```yaml
pageWidth: full
header:
  width: contained   # the header's content keeps the look's column over full pages
```

- `header.width` is a `Ui.PageWidth`: `contained` starts and ends the header's
  content — its whole row, `header-content` — exactly where a contained page
  does; `full` spans the bar, inset by the `space.page` token. The bar itself,
  its background and border, always spans the screen.
- Omitted, the application's `pageWidth` applies; with neither, `contained`.
  A page's own `width` never changes it, so the header is the same on every
  page. It is resolved by `ui`'s one resolver and carried in the application
  document as `header.width`; the `header` part carries it as `data-width`.
- Beside a sidebar the header spans the sidebar's column too, and a contained
  header's content sits over the page's column, so it moves with the sidebar
  — collapsed to its rail or expanded, at either side.
- The alignment is the renderer's (see [the styling contract](styling.md#tokens)),
  so it holds under every theme; a theme sets the measure and the inset
  through the `width.page` and `space.page` tokens.

## What the browser decides

A node's `shown` is a [condition](../../ui/docs/conditions.md), and a `value`
or `list` node names what it draws; on a page's own nodes they read `query` —
the declared parameters, from the address — in the browser. They never read
`request`, which only the server has: a condition naming it is
`CEL_UNKNOWN_IDENTIFIER` at `telo check` and refused when the application
starts. Delivery that depends on the request is `when:`, below.

```yaml
pages:
  - kind: Ui.Page
    path: /
    title: Account
    query:
      signin: { type: string, enum: [denied, expired] }
    children:
      - type: text
        text: Your sign-in was refused.
        shown: { at: !cel "query.signin", matches: { const: denied } }
```

A composite placed with a `shown` is drawn under it; when what it provides has
a `shown` of its own, the page document wraps it in a `box` carrying the
placement's, so both must hold.

## What is evaluated per request

Inside `children` and `header`, each node's `when:` and its leaf values — `text`, `href`,
`src`, `alt`, `markup`, `style` — may be expressions, evaluated for every
request against the request — and never against `query` or any other root the
browser holds (`CEL_UNKNOWN_IDENTIFIER`):

| Name | |
| --- | --- |
| `request.headers` | the request's headers, lower-case names; a repeated header joined with `, ` |
| `request.ip` | the client's address |

```yaml
children:
  - type: composite
    ref: !ref salaryTable
    when: !cel "'x-role' in request.headers && request.headers['x-role'] == 'hr'"
  - { type: text, text: !cel "'Signed in from ' + request.ip", style: muted }
```

A header may be absent, so test for it with `in` before reading it.

**The tree's structure and its references are literal.** A computed list of
children, a computed list item or a computed `ref` is `REF_SLOT_COMPUTED` at
`telo check` and `ERR_REF_SLOT_COMPUTED` at creation: a composite cannot come
out of an expression. Each composite a page places is resolved once, when the
page is created; one the header places, when the application starts.

A value that does not make a valid node once evaluated — an `href` that is no
allowed address (`javascript:…`, or `//host`, which is not app-relative), a
`text` that is not a string — replaces that one node with
an `error` node, code `ERR_UI_NODE_INVALID`, and is logged. The rest of the
page is served. Each node is checked once per request; what a composite
provides is checked once, when it is resolved.

## Languages

Every text the application shows — page titles, node texts, labels, a model's
titles and enumeration labels, the renderer's own words — is written in the
`lang:` of the module that wrote it. With a `translator`, the server looks each
one up and sends the browser the message it chose, already parsed, with the
language it is written in; the browser formats it — plural forms,
placeholders, numbers — with no catalog of its own. A text with no translation
is shown as written, and a text an expression computed is never looked up.

`lang` says which language a request asks for, evaluated per request like a
node's `when`:

```yaml
kind: I18n.Negotiator
metadata: { name: language }
translator: !ref t
default: en
---
kind: UiReact.App
metadata: { name: app }
title: Invoices
words: !ref Ui.words
translator: !ref t
lang: !cel "'accept-language' in request.headers ? Self.language(request.headers['accept-language']) : 'en'"
```

What is served is the **effective language**: the translator's catalog
language the request's tag falls back to (`pl-PL` finds `pl`), else the
language the application's `title` is written in. The documents carry it as
`lang`, the shell as `<html lang>`, and the server keeps one copy of every
document per effective language — a thousand different `Accept-Language`
values make at most one more copy than the translator has languages.

Each document's `Vary` names exactly the request headers its per-request
expressions read — `lang`, a token set's `when`, a navigation entry's `when`, a
page or header node's `when` and its values — read off the expressions themselves: `request.headers.cookie` or
`'cookie' in request.headers` gives `Vary: Cookie`, a header name computed at
request time `Vary: *`, and an application reading no header sends none. A
literal `lang` serves every request in that language.

## What the page draws when a node is wrong

A fault in one node never takes the page with it.

- A `link` whose `href` starts with `/` is a reference into the application.
  One that would leave it once the browser resolves it — `//host`, `/\host`,
  or either with a tab or a line break inside, which a browser drops — is
  refused where it is written and replaced by an `error` node where it is
  computed (above). The renderer holds the same line for a document that
  reaches it some other way: such a link is not drawn as a link, the `error`
  node `ERR_UI_NODE_INVALID` stands in its place, and a navigation entry
  whose address does so is shown the same way beside the navigation.
- A click on a link is taken as a move within the application only when it
  leads to a page the application declares. A `link` node to anything else
  under the mount — a file an `Http.Static` serves beneath it — is an
  ordinary browser load.
- Every node is drawn inside a boundary of its own — a page's children, a
  container's children, a filter bar's content, a table's cell. A node that
  fails while it is drawn is replaced by the `error` node; its siblings and
  everything around it stay.
- The application has a last boundary around all of it, so a failure outside
  every node shows the `error` node rather than an empty document.

A custom component's own failure keeps its own codes; see
[the component ABI](component-abi.md).

## Files it serves

Everything under `_telo/ui/assets/<digest>/…` — the renderer and its chunks,
component modules, every stylesheet including yours, font faces, icon files —
is read when
the application starts and served from memory under an address that never
changes. Editing one of your `stylesheets` takes effect when the application
is started again, under a new address.

## Tables and filter bars

- A table, a form and an option source read and write their `basePath` under
  the mount, as a reader reads its `source.path`: mounted at `/admin`,
  `basePath: /api/todos` lists from `/admin/api/todos` and edits
  `/admin/api/todos/<key>`. A write announces the change under the
  `basePath` as written, which is what `onSuccess.refreshes` names.
- A filter bar shows the filters on one property together: one label, and
  each control captioned by its operator — `from` and `to` for a range
  (`gte`, `lte`), `after` and `before` for `gt` and `lt`.
- A table's create and edit forms open in the [surface](../../ui/docs/surfaces.md)
  their opener names — a dialog when it names none — and a delete asks first
  in a confirmation. A modal dialog or drawer holds the keyboard focus and the
  page behind it does not scroll. Escape, a close button and a click outside
  close a surface where its `dismiss` leaves them on; Cancel always does, and
  Escape or Cancel a confirmation. Nothing closes a surface while its form is
  being sent.
- A delete the API refuses stays in its confirmation, which shows the refusal
  as an `error` node; the table and its rows are left as they were.
- The browser's autocomplete is off on every control typed into, in a form —
  and on the form itself — and in a filter bar.
- A filter chosen from a list applies at once. A yes/no property and an
  enumerated one are chosen from a list whose first entry, Any, clears the
  filter; under the `in` operator the list stays open and any number of its
  entries may be chosen. Text typed into a filter applies when it is committed
  — Enter, or leaving the field — so the tables inside the bar are asked once
  for the value meant.
- Edit, delete and the pager are icon buttons; each is named for a screen
  reader and shows that name on hover and on keyboard focus.
- A value whose model property declares `format: uri` or `uri-reference` is
  drawn as a link showing the value, in a table's cell, in a `list` node and
  in a `value` node. The value must be an address [a `link` node may
  hold](../../ui/docs/nodes.md#addresses): an app-relative path, which leads
  under the application's mount as a `link` node's does, or one starting
  `https://`, `http://` or `mailto:`. Anything else — `//host/x`,
  `javascript:…`, a path with a tab in it — is shown as plain text. A link
  to a page of the application moves within it. Any other — a file served
  under the mount (`/files/report.pdf`), another site, a mail address —
  carries `target="_blank"` and `rel="noopener"`, so it opens beside the
  application and what the page holds stays.

### Row actions

A table's [`rowActions`](../../ui/docs/table.md#row-actions) — and a `list`
node's, drawn the same way in a last cell of each row — are text buttons in
each row, showing each action's label in the order declared, before edit and
delete.

- A press sends the row's bound record at once — `POST`, as JSON, to the
  action's path under the mount, as an action's own press does. The record is
  read when the button is pressed.
- A row is one entry: until its press is answered — or, for a `serial` action,
  while it waits behind an earlier press of that action on the page — every
  row action and the delete button of that row are disabled, and a press on
  one sends nothing; the pressed button carries `data-state="submitting"`.
  Other rows stay usable, and so do edit, the create button, sorting and
  paging. While a delete is being sent, every row action is disabled.
- An entry's `enabled` disables its button while its condition does not hold
  over the row and the roots in scope, with `disabled-text` beside it; the
  action's own `enabled` plays no part.
- An entry with `confirm` asks first, in the confirmation a delete uses: the
  question is its title and its button carries the action's label. Cancel or
  Escape sends nothing.
- An entry with `prompt` opens that confirmation on the press with its fields
  under the title, each the control a form derives for the property. Its
  button sends what the fields hold together with the row's bound record;
  Enter in a field does the same. A value the input model refuses marks its
  field and nothing is sent. What was entered is kept until the dialog closes.
- Once the operation succeeds the confirmation closes, the action's `result`
  tree — when it declares one — is drawn in place of the button
  (`row-answer`), and its `onSuccess` applies. A table then reloads every table
  on the page over the same `source.basePath`; the answer stays while that
  row's key is on the shown page. In a list it stays as long as the answer the
  list is drawn from.
- An operation that fails reloads nothing. With a confirmation open, the
  refusal is shown in it as an `error` node: its button sends the record again,
  and Cancel dismisses it; an entry with `prompt` shows a 400 as a form does
  instead. Otherwise the action's `failure` tree is drawn beside the button
  (`row-failure`), and the next press clears it.

## Forms

- A list property is entered whole. One whose `items` declare `enum` is a
  group of options, any number of them chosen, and the list sent holds the
  chosen values in the order the model lists them. Any other list of scalars
  is typed one item at a time — Enter, a comma or leaving the box adds what
  was typed, each item has a button that removes it, and Backspace in the
  empty box removes the last — and each item is sent as the type `items`
  declares: a number for `number` / `integer`, in a number box.
- A list with nothing in it is left out of the record, and an edit form opens
  with the record's list in the control.
- In the page, a list is checked as a list and each item against the scalar
  keywords of `items`; the first item refused marks the field, and its
  control (`data-invalid="true"` on the group of options or the box of tags).
  An item typed twice is kept once.
- **Live validation.** What the model refuses of a field is shown as values are
  entered, once the field has been touched, and of every field on a
  submission — the keywords of the interpreted profile; any other is the API's.
  A 400 detail lands on the field whose property is the first segment of its
  `path` (`period.from` reaches the date range entering `period`) and stays
  until that field changes; one no shown field enters is shown under the form.
- **Field kinds.** An input field draws the control it names: `select` a list
  (several values for a list property), `options` side by side, `toggle` a
  switch (off sends `false`), `slider` between the property's `minimum` and
  `maximum`, `tags` typed items; `auto` derives one as above. A choice draws
  its source's options in a list or side by side, reading the next page as the
  list scrolls to its end (side by side, a `More` button). A picker shows the
  chosen values as their labels, linked by the source's `href` under the
  address rule, and opens its surface to search — after the typing pause, or at
  once on Enter, an answer to an older search discarded — and to choose from a
  list that reads one more page per scroll to its end. A date range draws its
  presets, shown on while the dates equal one, and the two dates; a start
  after the end blocks the submission and a range longer than
  `warnLongerThan` is warned of.
- **Option sources.** Every request sends the source's `pageSize` as `limit`.
  While a filter the source reads from `values` holds nothing, it reads and
  offers nothing; when one changes it reads from its first page again. A
  chosen value with no label in hand — the record being edited, a default, a
  kept value — is labelled by requests filtering `value` with `in`, at most
  `pageSize` values each, under the source's current filters; a value they do
  not return is dropped, which is also how chosen values are held to a
  changed filter.
- **Groups** are drawn as `field-group` sections, label and description first,
  around their fields; a hidden group's fields are hidden fields.
- **Kept values.** A form with `state` starts from the record it edits, else
  the address (`_telo.v.<key>.<property>`, each value as its JSON), else the
  store (`telo.ui:<mount>:v:<key>`), else the model's defaults and each date
  range's initial preset. Every change of a kept property is written to both,
  the address replaced and never pushed; values read back are held to the
  interpreted profile and the current fields, and to their option source.

## Actions

An [`action` node](../../ui/docs/action.md) is a form with one button, and
below it what the operation answered.

- The fields are a form's: the same controls, derived the same way, and the
  same check in the page before anything is sent. The button shows the
  action's `label`.
- A press sends the entered record — `POST`, `content-type: application/json`
  — to the action's `path` under the mount, as a reader reads its
  `source.path`: mounted at `/admin`, `path: /api/reports` is sent to
  `/admin/api/reports`. `onSuccess.refreshes` names paths as written. A field
  holding nothing is left out; a checkbox is always `true` or `false`.
- Every press clears the last answer, and the form takes no other press until
  the operation answers. A `serial` action's presses on the page — its form's
  and its rows' — are sent one after another, in the order they were made.
  The fields keep what was entered, whatever the answer.
- A success draws the `result` tree (`action-result`) over `result`, the
  record sent as `input` and what the form holds now as `values`. Its body is
  read only when that tree or `onSuccess.navigate` reads `result`, and must
  then be a JSON object the declared answer model accepts; any other body is a
  failure `ERR_UI_RESPONSE_INVALID`.
- Anything else draws the `failure` tree (`action-failure`) over `error` —
  `status`, absent when nothing answered, and the `code` and `message` of a
  `{ code, message }` body, else `ERR_UI_UNAUTHORIZED` for a 401,
  `ERR_UI_FORBIDDEN` for a 403 and `ERR_UI_REQUEST_FAILED` for anything else
  — `input` and `values`. A 400 also marks the fields its details name, every
  other detail under the fields.
- After a success, every reader whose `source.path` and every table whose
  `source.basePath` equals an entry of `onSuccess.refreshes` reads again, and
  `onSuccess.navigate` moves the page: within the application to a declared
  page, by a full load to any other app-relative address, by replacing the
  page for an `https://`, `http://` or `mailto:` one. A value that is no such
  address navigates nowhere.
- The drawn answer is cleared when a property `clearAnswerOn` lists changes.

## Surfaces

- **Compact.** One breakpoint for the whole application: while the viewport is
  narrower than `compactBelow`, a surface that declares `compact` is drawn as
  that dialog or drawer instead, and the `app` part carries
  `data-compact="true"`. The address is unchanged, so a link opens the same
  form at any width. A surface open when the viewport crosses the breakpoint
  is swapped in place: what was entered stays.
- **Address.** A surface declared with `address` keeps what is open in the
  page's query, under [the open key](urls.md#the-open-key).
- **Unsaved input.** Under `unsaved: confirm`, a form that holds unsaved input
  asks before anything closes it: its own close button, Escape, a click
  outside or Cancel; the navigation, a link, or a component's `navigate` to
  another page; and the browser's back and forward buttons, whose step is
  undone while the question is open and replayed if the user leaves. Leaving
  the document raises the browser's own prompt. The question is drawn as the
  delete confirmation is.
- **After a submit.** `close` closes the surface, `again` returns the form to
  the values it starts from — the record it edits, else the model's defaults
  and each date range's initial preset, never the address or the store, which
  hold the record just saved — for another record, `keep` leaves it open with
  its values; the list reloads in
  each, and a create returns it to its first page.
- A popover is anchored to the button that opened it. `start` and `end` follow
  the document's direction.

## Event stream

`_telo/ui/events` tells the page which renderer the server holds. A stream that
cannot be started has its connection closed, and one that cannot be released
when its client leaves is reported; both are logged by the application.

## Look

```yaml
theme: !ref UiReact.defaultTheme
tokens:
  - tokens: !ref acmeBrand
    when: !cel "'x-tenant' in request.headers && request.headers['x-tenant'] == 'acme'"
  - tokens: !ref defaultBrand
stylesheets:
  - !module-path ./console.css
```

`theme` is how every screen looks and which controls it is drawn with; it is
the same for every request. `UiReact.defaultTheme` is the built-in look, and
any [`UiReact.Theme`](theme.md) — one another module publishes, or one written
beside the application — takes its place with no other change. An application
with a look of its own declares a theme holding only stylesheets:

```yaml
theme:
  kind: UiReact.Theme
  stylesheets: [!module-path ./look.css]
```

`tokens` is the brand over the theme — `width.page` among them, the measure of
a contained page — and may follow the request: in a list,
the first entry whose `when` holds — or that has none — is used; if none
holds, the theme's own values apply. `when` reads the same `request`, and the
headers it reads join the application document's `Vary`.

What the page loads, in cascade order: the renderer's layout, the mechanics of
each control in use, the theme's token values, its stylesheets in order and the
chosen token set, every custom component's stylesheet, then `stylesheets` —
see [the styling contract](styling.md#layers).

Each face of a token set's font families that has bytes is served, and its
`@font-face` is written from the family's declaration; a family with no faces
contributes only its name. A face must be a TrueType, OpenType, WOFF or WOFF2
file — read from the file's first bytes, so this cannot be checked before the
application starts: anything else fails the start with
`ERR_UI_FONT_FORMAT_UNKNOWN`.

## Components

The application compares each placed component with what it hosts, once
for each node a composite provided. One built for another ABI, or importing a
specifier the ABI does not supply, is replaced by an `error` node
(`ERR_UI_COMPONENT_ABI_UNSUPPORTED`, `ERR_UI_COMPONENT_IMPORT_UNSUPPLIED`) and
logged once; the rest of the page renders. See [the component ABI](component-abi.md).

## Authentication

The application adds none. The renderer sends the page's same-origin
credentials with every request; put a guard on the mount or on the API to
require them. A 401 or 403 is shown as an `error` node where it happened —
`ERR_UI_UNAUTHORIZED` / `ERR_UI_FORBIDDEN` — for the page when a document was
refused, for the one table, form or action when a collection or an operation
was. Any other failed request is `ERR_UI_REQUEST_FAILED`, with the HTTP status
in its message; a form's or an action's 400 is shown on its fields instead.
