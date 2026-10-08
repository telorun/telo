# UiReact.App

An application of pages. A `Telo.Mount`: list it under an `Http.Server`'s
`mounts`.

| Field | | |
| --- | --- | --- |
| `title` | required | the application's name, shown in its header and as the document title |
| `lang` | | the content's language, written as the document's `lang`; absent, no attribute is written |
| `theme` | | one [`Ui.Theme`](../../ui/docs/theme.md), or a list of `{ theme, when? }` |
| `defaultTheme` | `true` | whether the built-in theme is served |
| `stylesheets` | | your own stylesheets, as host paths: `!module-path ./ui.css` |
| `compactBelow` | `40rem` | the viewport width below which every surface's `compact` replacement applies: a CSS length in `px`, `rem` or `em` |
| `pages` | required, at least one | `{ path, title, children }` each |

## Pages

```yaml
pages:
  - path: /
    title: Todos
    children:
      - { type: text, text: Open work, style: heading }
      - { type: composite, ref: !ref todos }
```

- `path` is literal, unique in the application and never under `/_telo`. It
  is an app-relative path: `/` followed by anything other than `/` or `\`,
  with no control character (a tab, a line break) anywhere — so `/`,
  `/reports` and `/a//b` are paths, and `//reports`, `/\reports` are refused
  by `telo check` (`SCHEMA_VIOLATION`), since a browser reads them as another
  host.
- Two pages at one path are refused: `RESOURCE_RULE_VIOLATED` with
  `data.rule: UI_PAGE_PATH_DUPLICATE` at `telo check`,
  `ERR_UI_PAGE_PATH_DUPLICATE` at creation.
- Every page gets a link in the navigation, in the order written.
- `children` is a list of [`Ui.Node`](../../ui/docs/nodes.md).

## What is evaluated per request

Inside `children`, each node's `when:` and its leaf values — `text`, `href`,
`src`, `alt`, `markup`, `style` — may be expressions, evaluated for every
request against:

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
application starts.

A value that does not make a valid node once evaluated — an `href` that is no
allowed address (`javascript:…`, or `//host`, which is not app-relative), a
`text` that is not a string — replaces that one node with
an `error` node, code `ERR_UI_NODE_INVALID`, and is logged. The rest of the
page is served. Each node is checked once per request; what a composite
provides is checked once, when the application starts.

## What the page draws when a node is wrong

A fault in one node never takes the page with it.

- A `link` whose `href` starts with `/` is a reference into the application.
  One that would leave it once the browser resolves it — `//host`, `/\host`,
  or either with a tab or a line break inside, which a browser drops — is
  refused where it is written and replaced by an `error` node where it is
  computed (above). The renderer holds the same line for a document that
  reaches it some other way: such a link is not drawn as a link, the `error`
  node `ERR_UI_NODE_INVALID` stands in its place, and a page whose `path` does
  so is shown the same way in the navigation.
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
component modules, every stylesheet including yours, font faces — is read when
the application starts and served from memory under an address that never
changes. Editing one of your `stylesheets` takes effect when the application
is started again, under a new address.

## Tables and filter bars

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
  drawn as a link showing the value, in a table's cell and in an action's
  list. The value must be an address [a `link` node may
  hold](../../ui/docs/nodes.md#addresses): an app-relative path, which leads
  under the application's mount as a `link` node's does, or one starting
  `https://`, `http://` or `mailto:`. Anything else — `//host/x`,
  `javascript:…`, a path with a tab in it — is shown as plain text. A link
  to a page of the application moves within it. Any other — a file served
  under the mount (`/files/report.pdf`), another site, a mail address —
  carries `target="_blank"` and `rel="noopener"`, so it opens beside the
  application and what the page holds stays.

### Row actions

A table's [`rowActions`](../../ui/docs/table.md#row-actions) are text buttons
in each row, showing each action's label in the order declared, before edit
and delete.

- A press sends the row's bound record at once — `POST`, as JSON, to the
  action's path.
- A table sends one row write at a time. Until the operation answers, every
  row action and every delete button of that table is disabled, in every row,
  and a press on one sends nothing; while a delete is being sent, every row
  action is. Edit, the create button, sorting and paging stay usable.
- An entry with `confirm` asks first, in the confirmation a delete uses: the
  question is its title and its button carries the action's label. Cancel or
  Escape sends nothing.
- Once the operation succeeds its answer is not read, the confirmation closes,
  and every table on the page over the same `source.basePath` reloads the page
  of rows it was showing.
- An operation that fails reloads nothing. The refusal is shown as an `error`
  node in the confirmation, which opens for it when no question was asked,
  titled with the action's label: its button sends the record again, and
  Cancel dismisses it. A 401 is `ERR_UI_UNAUTHORIZED`, a 403
  `ERR_UI_FORBIDDEN`, and anything else `ERR_UI_REQUEST_FAILED` — a 400 with
  every detail of its envelope in the message.

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
  control (`data-invalid="true"` on the group of options or the box of tags). `minItems`,
  `maxItems` and `uniqueItems` are left to the API. An item typed twice is
  kept once.

## Actions

An [`action` node](../../ui/docs/action.md) is a form with one button, and
below it what the operation answered.

- The fields are a form's: the same controls, derived the same way, and the
  same check in the page before anything is sent. The button shows the
  action's `label`.
- A press sends the entered record — `POST`, `content-type: application/json`
  — to the action's `path`, which is the origin's own address and is not
  moved under the application's mount. A field holding nothing is left out; a
  checkbox is always `true` or `false`.
- Every press clears the last answer and the last failure, and the button is
  disabled until the operation answers. The fields keep what was entered,
  whatever the answer.
- A success draws each declared list in order: its heading when it has one,
  a header per column, and a row per element of the list its `rows` names in
  the answer. A cell shows its value as a table's cell does. A list with no
  elements, and a `rows` that names something other than a list, show `No
  rows.`.
- A 400 is shown on the form: each detail naming a shown field on that field,
  every other detail — or the envelope's `message` when it has none — under
  the fields.
- Any other failure is an `error` node under the form, where the lists would
  be: `ERR_UI_UNAUTHORIZED` for a 401, `ERR_UI_FORBIDDEN` for a 403,
  `ERR_UI_REQUEST_FAILED` for any other status and for no answer at all.
- An action that declares lists needs a JSON object to draw them from: a
  success with any other body is `ERR_UI_RESPONSE_INVALID`. One that declares
  none never reads the body.

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
- **After a submit.** `close` closes the surface, `again` empties the form for
  another record, `keep` leaves it open with its values; the list reloads in
  each, and a create returns it to its first page.
- A popover is anchored to the button that opened it. `start` and `end` follow
  the document's direction.

## Event stream

`_telo/ui/events` tells the page which renderer the server holds. A stream that
cannot be started has its connection closed, and one that cannot be released
when its client leaves is reported; both are logged by the application.

## Themes

```yaml
theme:
  - theme: !ref acmeTheme
    when: !cel "'x-tenant' in request.headers && request.headers['x-tenant'] == 'acme'"
  - theme: !ref defaultBrand
```

One theme applies to every request. In a list, the first entry whose `when`
holds — or that has none — is used; if none holds, only the default theme
applies. `when` reads the same `request`.

Each face of a theme's font families that has bytes is served, and its
`@font-face` is written from the family's declaration; a family with no faces
contributes only its name. A face must be a TrueType, OpenType, WOFF or WOFF2
file — read from the file's first bytes, so this cannot be checked before the
application starts: anything else fails the start with
`ERR_UI_FONT_FORMAT_UNKNOWN`.

## Components

At start the application compares each placed component with what it hosts.
One built for another ABI, or importing a specifier the ABI does not supply,
is replaced by an `error` node (`ERR_UI_COMPONENT_ABI_UNSUPPORTED`,
`ERR_UI_COMPONENT_IMPORT_UNSUPPLIED`) and logged; the rest of the page
renders. See [the component ABI](component-abi.md).

## Authentication

The application adds none. The renderer sends the page's same-origin
credentials with every request; put a guard on the mount or on the API to
require them. A 401 or 403 is shown as an `error` node where it happened —
`ERR_UI_UNAUTHORIZED` / `ERR_UI_FORBIDDEN` — for the page when a document was
refused, for the one table, form or action when a collection or an operation
was. Any other failed request is `ERR_UI_REQUEST_FAILED`, with the HTTP status
in its message; a form's or an action's 400 is shown on its fields instead.
