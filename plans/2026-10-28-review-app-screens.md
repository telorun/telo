# Screens for a review app: address variables, Markdown with anchors, live refresh

## Goal

An application that reviews documents, watches workers or fronts a REST API keyed by ID is declared entirely in `ui`, with no frontend build. plan-approval is the acceptance case: its hand-written React review UI is replaced by pages declared in its server manifest, and its `/api/review/` routes stay exactly as they are.

What `ui` lacks for that, all generic:

- a page address and a request target that carry an ID (`/plans/{id}`, `POST /plans/{id}/decisions`), and a link built from a row;
- Markdown text drawn safely, with a control on the items the server names;
- screens that refresh on a timer without losing the viewer's place;
- a control that sets a page query parameter, row and column styles on a `list` node, filter values relative to now, and relative time display.

This is written against the shape the related-records plan leaves behind: `Ui.Listing`, `Ui.CollectionSource`, `Ui.CollectionPresentation`, `Ui.TableLayout`. It ships after that plan; `Ui.Table` and `Ui.Collection` no longer exist by then.

## 1. Address variables

### Page paths

Before: a page `path` is a literal. After: a segment may be `{name}`, standing for exactly one non-empty segment, percent-decoded.

- A segment is either wholly literal or exactly `{name}`; a brace anywhere else, or a repeated name, is `SCHEMA_VIOLATION`. `/plans/{id}` and `/runners/{name}/commands` are paths; `/plans/x{id}` is not.
- A literal segment beats a variable one (`/plans/new` over `/plans/{id}`). Two pages whose paths differ only in variable names are `UI_PAGE_PATH_AMBIGUOUS`.
- A page with a variable has no address of its own to link to from a menu, so a navigation entry naming one is `UI_NAVIGATION_PAGE_HAS_PARAMETERS`.
- A malformed encoded segment answers the application's not-found page.

### The `path` root

`path` is a browser root beside `query`: an object of the page's variables, each a string. It is readable wherever `query` is read today — a reader's trees and `source.params`, `value`, `list` and `shown`, an action's and a row action's inputs, a listing's roots.

- A reader, an action, a listing's source and an option source declare the names they read in `path`, the way they declare `query` (names, each optionally narrowed by a `Ui.Match`). The root is closed over them; an undeclared name is `CEL_UNKNOWN_FIELD`.
- A declared name the placing page's `path` lacks is `UI_PATH_PARAMETER_UNPROVIDED`, at check and as `ERR_UI_PATH_PARAMETER_UNPROVIDED` where the node is resolved.

### Request targets

A target is a path with `{name}` segments plus `pathParams`, a map from each name to an accessor over the roots in scope (`path`, `query`, plus `row` in a row action, `data` inside a reader, `input` and `result` after an action). It applies to:

- `Ui.Data.source`, `Ui.Action.source` — `path` and `pathParams`;
- `Ui.CollectionSource` — `basePath` and `pathParams`, over `path` and `query` only, since a source has no row; the source declares the `path` / `query` names it reads, and a listing, option source or presentation using it must declare at least those (`UI_SOURCE_PARAMETER_UNPROVIDED`);
- `onSuccess.refreshes` entries — a plain string, or `{ path, pathParams }` over `path`, `query`, `input` and `result`.

Rules: every `{name}` has exactly one binding and every binding names a segment (`UI_PATH_PARAMETER_UNBOUND`, `UI_PATH_PARAMETER_UNUSED`); a binding's type is string or integer (`CEL_TYPE_ERROR` otherwise). A filled value is percent-encoded as one segment, so an ID holding `/` or `..` cannot change the route. A binding that is null at run time sends nothing: the node draws its `failure` with `ERR_UI_PATH_PARAMETER_MISSING`.

**Invalidation matches the resolved URL.** The related-records plan's "every listing over the same `basePath`" becomes "every target resolving to the same URL"; a `basePath` with no variables resolves to itself, so nothing that plan declares changes. A write or `refreshes` reloads every reader, listing, facet request and relation's labels whose target resolves to the same URL, so `refreshes` of plan 7's decisions re-reads plan 7's page and not plan 8's. `notifyChanged` takes a resolved path. The address rule (app-relative, no `//`) is held on the resolved string.

### Links built from data

A node value is an accessor, never an expression, so `"/plans/" + row.id` cannot be written. An **address** is therefore a string or `{ path, pathParams }`, accepted at:

- `link.href` (and a menu item's);
- a new optional `href` on the `value` node, which draws the presented value as the link's text;
- a new optional `href` on a `list` column and on a `Ui.TableLayout` column, over `row`;
- a `Ui.CollectionPresentation` relation entry's `href`, over the related `row`, so a label can link to `/authors/<id>` rather than only to a URL the record stores.

The resolved address is held to the address rule in the browser; one that fails is drawn as plain text, as a `format: uri` value is today. A link to a declared page is a move within the application, anything else an ordinary load, as today.

### Docs

`page.md` (variables, the `path` root, ambiguity), `data.md`, `action.md`, `collection-source.md`, `collection-presentation.md` (a relation's `href` as an address), `nodes.md` (addresses, `href` on value and columns), `listing.md` (the `path` roots).

### Verify

- An inbox table row's title links to `/plans/<id>`; that page loads `GET /api/review/plans/<id>`; its Approve button posts to `/api/review/plans/<id>/decisions`; no route changed.
- Two pages `/a/{x}` and `/a/{y}` are `UI_PAGE_PATH_AMBIGUOUS`; `/plans/new` and `/plans/{id}` both route, the literal winning.
- A binding yielding `../x` is sent as one encoded segment.
- Approving plan 7 re-reads plan 7's reader and listing and leaves plan 8's alone.
- A reader reading `path.id` on a page whose path has no `{id}` is `UI_PATH_PARAMETER_UNPROVIDED`.
- A navigation entry naming `/plans/{id}` is `UI_NAVIGATION_PAGE_HAS_PARAMETERS`.
- Every rule is pinned both ways in `modules/ui/tests/`: refused by `telo check` at the declaring library, and `runFails:` from a consumer `telo check` does not reach.

## 2. Timed refresh

`refreshEvery` — a duration, at least `5s` (`UI_REFRESH_INTERVAL_INVALID`) — on `Ui.Data` and `Ui.Listing`. Unset, nothing changes.

It is a literal, or an accessor over `query`, so the viewer can pick the interval (with a `Ui.QuerySelect`, §4). A missing or empty parameter means no refresh. The declared `query` parameter must have an `enum`, and every member is held to the same rule as a literal (a valid duration of at least `5s`); a parameter with no `enum`, or a member failing the rule, is `UI_REFRESH_INTERVAL_INVALID`. Nothing the viewer picks reaches the timer unchecked, and nothing is clamped. One parameter can drive several readers and listings on a page.

- A tick reloads everything the node reads, under the related-records plan's reload rule (loaded pages refetched in order, the first page only past ten, records matched by `key` so focus, open surfaces, expanded state and entered values stay). For a listing that is every group, period and loaded level, and the facet requests over its source.
- A tick is skipped while a read of that node is in flight, and not run while the document is hidden; coming back to visibility runs one read if an interval has passed. A node hidden by `shown` reads nothing.
- A read that fails on a tick keeps what is drawn and shows the listing's or reader's `failure` beside it, as a failed reload of `Ui.Data` does today; the next tick tries again.
- `Ui.Data` keeps its content mounted, as it does for `reloadOn`.

Docs: `data.md`, `listing.md`.

**Verify:**
- A runner page with two loaded pages of command history shows a new command and a session that went inactive within one interval, still on its second page, scroll position unchanged.
- An open edit form keeps its entered values across a tick that changed its row.
- A hidden tab makes no request; showing it makes one.
- A tick during a slow read makes no second request.
- `refreshEvery: 1s` is `UI_REFRESH_INTERVAL_INVALID`.
- A `Ui.QuerySelect` with `choices` of `5s`, `30s` and `1m`, bound to a declared parameter that a reader's `refreshEvery` reads, changes the tick rate; clearing it stops the ticks; the choice survives a reload, and with a `Ui.LocalStore` in `state` survives a new visit.
- A parameter read by `refreshEvery` with no `enum`, or with an `enum` member below `5s`, is `UI_REFRESH_INTERVAL_INVALID`, pinned both ways.

## 3. Markdown with anchors

A `markdown` node: `{ type: markdown, text, anchors? }`.

- `text` is an accessor to a string (`data.revision.body`, `row.body`).
- The profile is CommonMark plus GFM tables, task lists, strikethrough and autolinks. Raw HTML is drawn as text, never inserted; the renderer builds elements and has no path to the document's markup. Links and images are held to the address rule (a failing link is plain text, a failing image its alt text); an external link opens in a new tab with no opener. Code blocks are plain, unhighlighted.
- The renderer is a separate lazy chunk of `ui-react`, fetched when the first `markdown` node is drawn; the text shows preformatted until it arrives. There is one Markdown renderer in the repo — a chat surface, now or later, uses this one.

**Anchors** are items the server names. `anchors` is `{ rows, line, count?, label?, action }`:

- `rows` is an accessor to a list; each member is an `anchor`, typed as an element of `rows`. Which blocks are items, and their IDs, are the server's grammar; the node parses none.
- `line` is an accessor over `anchor` to the 1-based source line that starts the item; `count` an optional accessor to an integer shown on the control; `label` an optional text (a `Ui.BoundText` over `anchor`), by default the word `comment`.
- `action` is a `Ui.RowAction` whose region binds `anchor`, the way a table's binds `row`: `inputs` bound from `anchor.id` and the roots in scope, `prompt: true` for the fields the anchor does not fill, `confirm?` and `enabled?` as there. `inputs` is judged as a call-site argument map against the action's `inputModel` with the existing codes, twinned by `ERR_UI_ROW_ACTION_INPUTS_INVALID`.
- The control is drawn on the block containing `line` (a list item for an item line, a heading for a heading line); two anchors on one block draw two controls in order. An anchor whose line is past the text is drawn after the text as an unplaced item with its control, so nothing is lost silently.
- A pressed anchor action behaves as a row action: its prompt, its answer in place of the control, its `failure` beside it, a 2xx re-reading what its `refreshes` names.

`Ui.SpecNode` gains `markdown`, every member present. The part list (a data file) gains the Markdown parts, styled by the default theme and by `ui-react-radix`; the anchor control reuses the action button part and `badge`. `ui_react_controls-2` is unchanged. New words (`comment`, the pre-load text) join the English `Ui.words` set.

Docs: `nodes.md` (the node, the profile, anchors), `action.md` (anchor actions), a new section in `modules/ui-react/docs/`.

**Verify:**
- A plan page shows the latest revision's body as Markdown; each anchor the server declared has a control with its count; pressing one opens the comment action with `item` set to the anchor's ID.
- A `<script>` and an `<img onerror>` in the body appear as literal text; a `javascript:` link is plain text.
- A table, a task list and a fenced block render.
- An anchor naming line 999 of a ten-line text is drawn unplaced after it.
- Renderer tests pin the profile and the anchor placement; `ui` tests pin `anchors` typing (`anchor.nmae` is `CEL_UNKNOWN_FIELD`).

## 4. A control that sets a page query parameter

`Ui.QuerySelect`, a composite, drawn through the existing `Select` control (`type: queryselect` on the wire).

| Key | | |
| --- | --- | --- |
| `query` | required | the page query parameters it reads and writes, a `Ui.QueryParameters` |
| `parameter` | required | the one declared parameter it writes |
| `label` | required | a `Ui.BoundText` |
| `options` | one of | `{ rows, value, label }` — `rows` an accessor to a list in the roots in scope (inside a `Ui.Data`, `data`), `value` and `label` accessors over `row` |
| `source` | one of | a `Ui.OptionSource` (a `Ui.CollectionOptions`, say) |
| `choices` | one of | fixed options, `[{ value, label }]`, `label` a `Text` — for a list the author writes, such as refresh intervals |
| `placeholder` | the word `select` | |
| `clearable` | `false` | whether the viewer can return to no value |
| `state` | none | a `Ui.StateRecord`, the record forms and filter bars use, to remember the choice across visits |

Exactly one of `options`, `source` and `choices` is written (`SCHEMA_VIOLATION`).

Choosing writes the parameter to the page's address by replacing the current history entry, as a filter bar does; every reader and listing declaring that parameter re-reads, since they already follow the address. A value in the address that no option offers shows nothing selected and leaves the parameter as it is.

With `state`, the choice is also kept in its store, and the control starts from the address, else the store, else the parameter's default. A stored value no option offers is ignored.

Rules, each with an `ERR_` twin: `UI_QUERY_SELECT_PARAMETER_UNDECLARED`, `UI_QUERY_SELECT_PARAMETER_NOT_SCALAR` (an array parameter), `UI_QUERY_SELECT_VALUE_MISMATCH` (option values not string or integer, or not what the parameter's schema admits).

Docs: new `query-select.md`.

**Verify:** a diff page's "Base" and "Compared" selects list the plan's revisions from a `Ui.Data`, and choosing one re-reads the diff reader with `base` / `target`; the address carries both and a reload restores them; the three rules are pinned both ways.

## 5. Style rules on `list`

A `list` node takes `rowStyle`, and a column takes `style`, each a `{ by, cases, default? }` rule over `row`, as a table's column does. Docs: `nodes.md`.

**Verify:** a line diff drawn as a `list` shows added lines `success` and removed lines `danger`; a `by` that is not a plain chain is `ACCESSOR_NOT_PLAIN_CHAIN`.

## 6. Relative values

### In filters

A `date` or `date-time` filter's `default` and a preset's value may be `{ unit: minute | hour | day | week | month | year, offset }`: now moved by `offset` units in the viewer's time zone — the instant for a `date-time`, that moment's date for a `date`. Legal with `eq`, `gt`, `gte`, `lt`, `lte`; not with `in`.

- A value that came from a relative default or preset stays relative while the viewer leaves it: the active preset is still read off the bar's values, the address and the store keep the relative spelling `now<±n><unit>` (`now-1day`), and each request sends the resolved value at the moment of the read.
- Typing a value replaces it with an absolute one.
- A relative value on another property type, or with `in`, is `UI_FILTER_DEFAULT_INVALID` / `UI_FILTER_PRESET_VALUE_INVALID`, the codes the other defaults use.

Verify: an inbox filter "Waiting: 1 day or older" (`lte`, `offset: -1`, `unit: day`) asks for rows older than one day relative to the day it is read, with the same link a day later; its preset stays active after a reload; the address reads `now-1day`.

### Relative time display

`value` and a `list` column take `relative: true`: a `date-time` (or `date`) is drawn as relative time in the viewer's language ("3 hours ago"), with the exact time as its tooltip and the element's machine-readable time, refreshed every minute while on screen. On any other type it is `UI_VALUE_RELATIVE_NOT_DATE`.

Verify: a `date-time` value drawn with `relative: true` reads "3 hours ago" for a time three hours back, with the exact time on hover; `relative: true` on a string without `format: date-time` or `date` is refused.

Docs: `filters.md`, `nodes.md`.

## 7. Remembered value across forms

Before building: confirm by test that two actions' fields over one property, each declaring the same `state` key with a `Ui.LocalStore` and `fields` listing that property, prefill the same remembered value (an `author` entered once). If this does not hold, the generic fix is part of this work, never a per-app workaround. The test lives in `modules/ui/tests/` and the renderer's package tests; the behaviour is documented in `field-kinds.md`.

## 8. Docs, guides, ledger

- `modules/ui/README.md` and the docs named above; `modules/ui-react/` docs for the renderer parts.
- `apps/hub/guides/build-ui.md` and `apps/authoring-agent/chat/primer.md`: path variables and `pathParams`, addresses, `refreshEvery`, `markdown` and anchors, `Ui.QuerySelect`, `list` styles, relative values, `relative`.
- `docs/guides/what-you-get.md`, under Standard library: "Routes keyed by ID" (page paths with variables, request targets filled from them, refused before the app runs when a name is unbound or mistyped); "Screens that refresh in place" (`refreshEvery` keeps loaded pages, scroll and open forms); "Markdown without raw HTML" (rendered safely, links held to the address rule).
- `modules/CLAUDE.md`: the Declarative UI paragraph gains the `path` root, address templates, the `markdown` node, `Ui.QuerySelect` and `refreshEvery`.

## 9. Checks to run before building on them

Each confirmed by reading, not by running. Check with a minimal manifest first; where one fails, the generic extension it names is part of this work.

1. `UiReact.App` routes `{name}` segments, a literal beating a variable one. If not, extending its page routing is part of this work.
2. A rule on a reader can see the placing page's path through nested composites. If not, the page, which already resolves its composites at creation, judges each composite's declared names and raises the twin.
3. A map whose values are accessors (`pathParams`) is typed as call-site arguments against a template's names. If not, the accessor-map handling `Ui.RowAction.inputs` uses is generalised.
4. `anchor` is typed as the element of the list `rows` names, through the relative-pointer binding the `list` node's `row` uses.
5. A duration field with a lower bound is expressible as a resource rule.
6. A lazily loaded chunk of a browser entry is served by digest and loaded on demand under the current browser-entry build.

## 10. Acceptance: plan-approval

Every page its `web` package README lists is declared in the server manifest on the kinds above; `web`, `UI_DIR` and the UI build in its Docker Compose are deleted; the existing `/api/review/` routes are unchanged.

**Verify:** the inbox, plan page (Markdown, anchors, decisions, diff selects), settings and runner pages each load against the unchanged API; the app's own tests pass; `pnpm run telo` starts it with no frontend build.

An `examples/ui-showcase` page set exercises the same features against a small fixture server, with a test under its own `tests/` run by `examples/test-suite.yaml`.

## Releases

One fragment per module, written with `telo release add`, each body naming only its own module:

| Module | Kind | What the body says |
| --- | --- | --- |
| `ui` | `Added`, describing the break | page path variables (a literal brace in a page path now is a variable), the `path` root and `pathParams`, addresses, `refreshEvery`, the `markdown` node, `Ui.QuerySelect`, `list` styles, relative filter values, `relative` |
| `ui-react` | `Added` | path routing, the Markdown renderer chunk, timed refresh, query select, relative time |
| `ui-react-radix` | `Added` | styles for the Markdown parts and the anchor control |

A changeset goes on each changed package changesets versions, including `@telorun/ui-react-contract` if the part list moves.

**`requires:` floors:** none by default. A module gets one only if running the previous published CLI against it with the block stripped rejects it; restoring the block must then give `MODULE_REQUIRES_NEWER_RUNTIME`. An app writing `/plans/{id}` is judged by its own author's floor.
