# UiReact.App

An application of pages. A `Telo.Mount`: list it under an `Http.Server`'s
`mounts`.

| Field | | |
| --- | --- | --- |
| `title` | required | the application's name, a text used as the document title |
| `theme` | required | one [`UiReact.Theme`](theme.md): `!ref UiReact.defaultTheme`, a theme another module publishes, or one of your own |
| `tokens` | | your brand: one [`Ui.DesignTokens`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/), or a list of `{ tokens, when? }` |
| `stylesheets` | | your own stylesheets, as host paths: `!module-path ./ui.css` |
| `compactBelow` | `40rem` | the viewport width below which every surface's `compact` replacement applies: a CSS length in `px`, `rem` or `em` |
| `pageWidth` | `contained` | how wide a page's content is drawn when the page declares no `width`: `contained` or `full` — see [Page width](#page-width) |
| `layout` | | the [`Ui.PageLayout`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) every page is drawn in, unless its `pages` entry names another — see [Layouts](#layouts); omitted, pages are drawn with no chrome |
| `pages` | required, at least one | each entry a [`Ui.Page`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/), written in place or `!ref`, or a `Ui.PageRoute` `{ page, layout }` |
| `notFound` | | nodes drawn, inside the layout, for a path no page serves — see [Not found](#not-found) |

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

- Each entry is a [`Ui.Page`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/): its `path`, optional `title`,
  `query` and `children`; the `title` names the document and the page's
  navigation entries and draws no heading — a page that wants one writes a
  `text` node with `style: title`. The application invokes it for every
  request to its path; the page's composites are resolved once, when the page
  is created.
- Two pages at one path are refused, and so are two whose paths differ only
  in the names of their [variables](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/)
  (`/plans/{id}`, `/plans/{key}`), since both route the same addresses:
  `RESOURCE_RULE_VIOLATED` with `data.rule: UI_PAGE_PATH_DUPLICATE` at
  `telo check`, `ERR_UI_PAGE_PATH_DUPLICATE` at creation. The rule reads the
  page of each entry, whether it is written alone or in a `Ui.PageRoute`.
- A page's `query` declares the query parameters its own nodes read; the page
  document carries it, `{}` when none is declared.

### Routing

An address opens a page by its segments, on the server — for the shell's
status and the page document — and in the browser, for which clicks are moves
within the application:

- A page path's `{name}` segment takes exactly one non-empty segment of the
  address, percent-decoded, and the page's nodes read it as `params.<name>`
  wherever they read `query`. A literal segment matches only itself.
- Where several pages match, the one with a literal segment first where the
  others have a variable opens: with `/plans/new` and `/plans/{id}` listed,
  `/plans/new` opens the first and `/plans/7` the second.
- An address no page matches — a malformed percent-encoded segment included —
  opens the not-found page.
- A move to another value of a page's variables draws the page afresh, since
  it shows another record: what its forms hold, its listings' loaded pages and
  its open surfaces start again, and no document is fetched. A move that
  changes only the query keeps every node mounted.

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
  the `width.page` [design token](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/), and
  centred; a `full` one takes all the room it has.
- A page's own `width` wins; with none, the application's `pageWidth`
  applies; with neither, `contained`. The default is filled by `ui`'s page,
  which the application invokes with its `pageWidth`, and the page document
  carries the result as `width` — so one page listed by two applications can
  be drawn at two widths.
- The `page` part carries it as `data-width`, and the renderer's own layer
  applies the measure (see [the styling contract](styling.md#tokens)): a theme
  sets the measure through `width.page`, never by a `max-width` on `page`.
- A layout's header and footer follow its own width, else the application's, not
  the page's — see [Layouts](#layouts).
- A misspelt value is `SCHEMA_VIOLATION` at `telo check`.

## Layouts

The chrome around a page is a [`Ui.PageLayout`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/): a
`header`, an `aside` and a `footer` around the page's own nodes. The
application assigns them — a page never names its layout, so a library's page
is drawn in whatever layout the application listing it chooses:

```yaml
layout:                          # every page, unless its entry names another
  kind: Ui.PageLayout
  header:
    - type: pane
      ref:
        kind: Ui.Navbar
        title: Acme
        navigation:
          items:
            - { type: page, page: !ref home }
            - { type: page, page: !ref reports, when: !cel "'x-role' in request.headers" }
  footer:
    - { type: text, text: Acme Corporation, style: muted }
pages:
  - !ref home
  - !ref reports
  - { page: !ref signIn, layout: { kind: Ui.PageLayout } }   # an empty layout: no chrome
  - { page: !ref print, layout: !ref printChrome }
```

- A `pages` entry that is a page is drawn in the application's `layout`; a
  `Ui.PageRoute` (`{ page, layout }`, both required) draws its page in the
  layout it names, and `layout: { kind: Ui.PageLayout }` is an empty layout: a
  layout like any other, with an id, that writes no header, aside or footer, so
  the page is drawn with no chrome and no heading. With no `layout` at all and
  no route, no page names a layout and every page is drawn with no chrome.
- The App is the only caller of a layout. Navigation is explicit: a
  [`Ui.Navbar`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) or
  `Ui.NavigationColumn` takes its `navigation` tree, and nothing is derived from
  `pages`. Their rules — an entry naming a page with no title or with a
  variable in its path — are the navigation pane's own.
- A layout and every pane it holds are evaluated for each request, so a navbar
  follows a sign-in, a session expiry or a role header at the next navigation.
- The width of a layout's header and footer is its `width`, else the
  application's `pageWidth`, else `contained`, whatever width a page declares.
  Each region insets its content against the box it spans: the header and
  footer against the application's width, `main` against `main`. Beside no
  aside a contained header and a contained page line up; with an aside beside
  `main` the two columns do not, since `main` is narrower than the application.

### How the renderer gets a layout

A layout travels on its own, as the [layout document](urls.md#the-layout-document),
named by an id the [application document](urls.md#the-application-document)
gives each page (`pages[].layout`) and the default (`layout`).

- The renderer fetches a layout document the first time it needs an id, and
  revalidates it with `If-None-Match` in parallel with each page document it
  fetches and when the event stream reconnects. A `304` keeps the layout in
  place; a new `digest` redraws it, so between two pages with the same id
  the header, the aside and the footer stay mounted — a menu does not flash and
  a folded aside stays folded.
- The id is a digest of the `UiReact.App` field that first names the layout
  declaration (`/layout`, `/pages/3/layout`), so every replica answers the same
  id, two entries naming one declaration share one, and two inline layouts have
  two. A layout with nothing written has an id like any other, and its document
  holds empty regions and no `aside`.
- A `304` is decided by the digest of the document produced for that very
  request, so it never crosses users with different headers.

### What a layout and `notFound` read

A layout's regions and `notFound` read `request` (`headers`, `ip`, `lang`) at run time and withhold `params` and `query` (`x-telo-context-withheld`), because one layout is drawn on pages with different variables: a composite placed there reading `params.id` is `CEL_UNKNOWN_IDENTIFIER`, naming the layout and why. A [`Ui.Data`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/)
there still reads the `query` it declares itself. A composite and a pane
inside it are resolved once, when the application starts; a pane placed in a
region or a page's `children` is invoked for every request. The structure of
the tree and its references are literal, as for a page.

### Page references are checked

Every reference to a page reachable from the application — a navigation entry,
a `link` address, an action's `onSuccess.navigate`, in a layout, a pane, a
composite or a page — must name a page `pages` lists, or
`telo check` reports `RESOURCE_RULE_VIOLATED` with `data.rule: UI_PAGE_UNROUTED`
at that reference; one written in a library the application imports is
reported at the slot of the application's own modules where it entered that
library. A library's page listed through its alias is never reported. An unlisted
page named by the entry module's own files is an error the load refuses, so
`telo run` exits 1 with the same diagnostic; no check at run time repeats it,
so only a dependency's unlisted page reaches a running application, where its
link opens the not-found page.

### Not found

An address no page serves answers the [not-found document](urls.md#the-page-document)
with `children`: `notFound`'s nodes produced for the request, drawn by the
renderer inside the application's default layout, so a missing page keeps its
navigation. Omitted, `children` is a heading and a sentence naming the address,
in the language of the request.

### Icons

A navigation entry's `icon` (a [`Ui.Icon`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/)) is drawn as the
`glyph` part before its text. The file is read when the application starts and
served, like every other, under `_telo/ui/assets/<digest>/<name>` by every replica from
boot, the layout document naming it as `{ digest, name }`. The glyph is an empty
`span` whose `--ui-react-glyph` custom property names that address, which the
renderer's layout uses as a mask over `currentColor`: the glyph takes the
colour of the entry's text and none of the file's markup enters the page. A
file that is not an SVG, PNG or WebP image is refused with
`ERR_UI_ICON_FORMAT_UNKNOWN` when the application starts. A chat button's icon is
the same glyph, its file served by the same rule.

## What the browser decides

A node's `shown` is a [condition](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/), and a `value`
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

Inside `children`, a layout's regions and `notFound`, each node's `when:` and its leaf values — `text`, `href`,
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
page is created; one a layout places, when the layout is created.

A value that does not make a valid node once evaluated — a `style` naming none
of the known styles, a `text` that is not a string — replaces that one node with
an `error` node, code `ERR_UI_NODE_INVALID`, and is logged. The rest of the
page is served. Each node is checked once per request; what a composite
provides is checked once, when it is resolved.

## Languages

Every text the application shows — page titles, node texts, labels, a model's
titles and enumeration labels — is written in the `lang:` of the module that
wrote it. The application translates them through its own `translations:`
block, the one set every surface of the application shares. What the renderer
draws on its own — "Save", the pager, each validation message — is
[`ui`'s own texts](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/), keys of the set
`Ui.Translations`: English with nothing listed, and in another language once its
shipped translation is listed:

```yaml
kind: Telo.Application
metadata: { name: Invoices, version: 1.0.0 }
lang: en
translations:
  catalogs:
    - !ref Ui.polishTranslations
    - kind: Telo.TextTranslations
      lang: pl
      texts:
        - { text: Invoices, translation: Faktury }
```

`UiReact.App` takes no language setting of its own. It serves each request in the
language the HTTP server negotiated for it (`request.lang`: `Http.Server.preferredLanguages`,
then `Accept-Language`, then the application's `lang:`), so a cookie or a
`?lang=` query is chosen with the server's `preferredLanguages`. The same language is `request.lang` in every per-request expression (page nodes, tokens, layouts and not-found nodes), and reading it adds the headers the negotiation used to `Vary`. The server looks
each text up and sends the browser the message it chose, already parsed, with the
language it is written in; the browser formats it — plural forms, placeholders,
numbers — with no catalog of its own. A text with no translation is shown as
written, and a text an expression computed is never looked up.

### Keyed texts

`UiReact.App` names the keyed sets it shows in `x-telo-text-keys` on its
schema root — `[Ui.Translations]`. The application document carries them as
`texts`: under `sets`, per set (by its canonical kind) each key's message in the
request's language, already layered over every listed catalog of that set and
parsed; and under `own`, the set the renderer's own texts are drawn from — the
first set the kind names. A node's keyed text, `{ set, key }`, is drawn from
`sets`; the renderer names no set itself, so a kind extending `UiReact.App`
that shows another library's keyed texts as well names `Ui.Translations` first
and the other sets after it.

The documents carry the negotiated tag as `lang`, the shell as `<html lang>`, and
the server keeps one copy of every document per served language — a thousand
different `Accept-Language` values make no more copies than the application
serves languages.

With more than one language served, every shell, application and page response
carries `Content-Language` and `Vary: Accept-Language`; an application serving
one language sends neither. Each document's `Vary` also names exactly the other
request headers its per-request expressions read — a token set's `when`, a
navigation entry's `when`, a page's node's `when` and its values — read
off the expressions themselves: `request.headers.cookie` or
`'cookie' in request.headers` gives `Cookie`, a header name computed at request
time `*`, and an application reading no header adds none. A layout document and a page holding a [pane](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) vary by `*`, since a pane is handed the whole request.

## What the page draws when a node is wrong

A fault in one node never takes the page with it.

- A `link` whose address resolves to a path starting with `/` is a reference
  into the application. One that would leave it once the browser resolves it —
  `//host`, `/\host`, or either with a tab or a line break inside, which a
  browser drops — is refused where it is written. An address that does not
  resolve at all (an empty path parameter, a result that is no address) is
  drawn as plain text, and `ERR_UI_ADDRESS_UNRESOLVED` is reported once in the
  console ([addresses](urls.md#addresses)). A navigation entry
  whose address does so is shown the same way beside the navigation.
- A click on a link is taken as a move within the application only when it
  leads to an address a page the application declares [opens](#routing). A `link` node to anything else
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

## Listings and filter bars

A [`Ui.Listing`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) is drawn by its
[layout](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) — a table, a list, cards, a board,
a calendar, a timeline, a tree, or a module's own component — and everything
but the drawing is the listing's, whatever the layout:

- **Reading.** The listing executes its layout's read plan (`reads`): one
  read per group value, per shown period and per tree level, each paged by
  `pageSize` and carrying the listing's `filters`, every filter bar around it
  and the viewer's sort, in the order
  [`conformance/listing-reads.json`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) pins.
  While a fixed filter holds nothing, nothing is read.
- **Paging.** Under `paging: pages` a pager keeps the cursors read, so
  previous replays a page. Under `more` a Load more button at the end appends
  the next page; under `scroll` it stays there, focusable, and is pressed by
  itself while it is in view and a further page exists. Under both, only the
  pages near the viewport are drawn — a page out of view stands in at its
  height, unless it holds the focus or an open inline form — so a long list
  stays fast however far it is scrolled. The count shown is the collection's
  `total`.
- **Sorting.** The viewer's sort is the listing's: a table sorts by a header,
  a list, cards, a board and a tree by a sort control above the records, each
  ascending then descending. A calendar and a timeline draw no control but
  still send the sort. A sort or a filter change returns every read to its
  first page.
- **Reloading.** A write, a delete, a row action, `notifyChanged(path)` and an
  action's resolved target and `onSuccess.refreshes` reload every listing whose
  source has that `basePath` — a templated one as it resolves
  ([invalidation](urls.md#invalidation)) — and every `values: present` filter
  over it. `reloadEvery` reloads the listing on a timer by the same rule, with
  the `values: present` filters over its source: a tick is skipped while one of
  its reads is in flight, none runs while the document is hidden, and coming
  back to it reads once if an interval has passed. A tick, or any reload, that
  fails keeps the records drawn with the failure beside them. A reload keeps
  what is drawn until it answers: it reads the loaded pages again from the
  first, each with the cursor the one before answered, and draws them
  together; with more than 10 pages loaded in a read it reads the first page
  alone, in place, leaving the rest as drawn. A record whose key remains keeps
  its element — its focus, an open inline form and what that form holds — and
  a record a write answered with is drawn from that answer at once, wherever
  it is shown.
- **Related records.** A column over a property whose relation the listing
  presents shows the related record's label, linked where the relation gives
  `href`. The keys of every page answered in one turn are looked up together
  with `in`, in batches of the relation's `pageSize`, each key once; a change
  announced for the relation's source `basePath` looks them up again. A lookup
  that fails is drawn as an `error` node under the records, which keep their
  keys.
- **Moving.** A layout's `move` runs when a record is dragged to another
  board column, calendar day, timeline column or lane, or tree record — or
  moved there through its "Move to" menu (`moveTo`), the keyboard path of every
  drag. The gesture fills `to` and the move's row action is sent with the
  inputs it binds over `row` and `to`, never a replace through the edit form;
  a 2xx answer reloads every listing over the collection, as a write does,
  and a refusal is drawn beside the record's buttons. A board column and a
  calendar day also offer creating a record holding their value.
- **Compact.** Below the application's breakpoint the `compact` layout is
  drawn when there is one; the reads, the sort and an open form are kept.
- **Empty.** When the reads answer no record, the listing's `empty` node is
  drawn where the records would be.

Each built-in layout draws its records as the [layout
contract](layouts-abi.md) hands them over:

| Layout | Draws | Reads |
| --- | --- | --- |
| table | a data grid, a header per column | pages, as `paging` says |
| list | the records one under another, each drawn with `content` | pages, as `paging` says |
| cards | a grid of cards as wide as `size` says | pages, as `paging` says |
| board | a column per group, headed by its label and its read's `total` (`valueCount`) | each column on its own, by "Load more" |
| calendar | the days of a month, a week or a day, the viewer moving between periods and views | every page of the period shown |
| timeline | bars over a column a day, week, month or quarter — the days of a month, the weeks of a quarter, the months of a year or the quarters of three years — in a lane per group | every page of the period shown, per lane |
| tree | the roots, a record's children under it once expanded; what is expanded is kept across reloads | each level on its own, by "Load more" |
| component | whatever the module's component draws | as its plan says |

A component layout's entry is held to the layout contract when the
application starts; one built for another is drawn as an error node in place
of its listing (`ERR_UI_COMPONENT_ABI_UNSUPPORTED`).

- A listing, a form, a filter bar and an option source read and write their
  `basePath` under the mount, as a reader reads its resolved `source`: mounted
  at `/admin`, `basePath: /api/todos` lists from `/admin/api/todos` and edits
  `/admin/api/todos/<key>`. A templated `basePath` is resolved over `params`
  and `query` as a request target is; one that does not resolve sends nothing
  and draws an `error` node (`ERR_UI_ADDRESS_UNRESOLVED`) — in place of the
  listing, at the top of a form, as the failure of a filter's present values
  or of an option source. A write announces the change under the resolved
  `basePath` (and an edit or delete also under the record's own path), which
  is what a reader or an action's `refreshes` names.
- A filter bar shows the filters on one property together: one label, and
  each control captioned by its operator — `from` and `to` for a range
  (`gte`, `lte`), `after` and `before` for `gt` and `lt`.
- A listing's create and edit forms open in the [surface](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/)
  their opener names — a dialog when it names none — and a delete asks first
  in a confirmation. A modal dialog or drawer holds the keyboard focus and the
  page behind it does not scroll. Escape, a close button and a click outside
  close a surface where its `dismiss` leaves them on; Cancel always does, and
  Escape or Cancel a confirmation. Nothing closes a surface while its form is
  being sent.
- A delete the API refuses stays in its confirmation, which shows the refusal
  as an `error` node; the listing and its records are left as they were.
- The browser's autocomplete is off on every control typed into, in a form —
  and on the form itself — and in a filter bar.
- A filter chosen from a list applies at once. A yes/no property and an
  enumerated one are chosen from a list whose first entry, Any, clears the
  filter; under the `in` operator the list stays open and any number of its
  entries may be chosen. Text typed into a filter applies when it is committed
  — Enter, or leaving the field — so the listings inside the bar are asked once
  for the value meant.
- A filter over a property whose relation the bar's presentation presents, or
  with `options` of its own, offers the records of that source by their
  label, a page more as its list is scrolled to its end. Under
  `values: present` it offers only the values the
  [facet request](https://hub.telo.run/module/oci/ghcr.io/telorun/data-model/) answers at the
  bar's `basePath`, under every other filter of the bar and of the bars
  around it but never its own, each shown with its count (`valueCount`);
  related keys are labelled with one batched `in` request per page of values.
  A change announced for the bar's `basePath` reads them again, whether or not
  the bar holds a listing.
- A `date` or `date-time` filter holding a value relative to now — from a
  relative `default` or preset — holds it as `now<±n><unit>` (`now-1day`) in
  the bar, the address and the store, so its preset stays active. Its control
  shows it as it resolves now. A read resolves it in the viewer's time zone
  when it asks for a first page — of a listing read, of a reload cycle (every
  loaded page of the cycle sends that one value), of a grouping's or a
  filter's present values — and every later page of that sequence sends the
  same value, since its cursor was issued for it. With more than 10 pages
  loaded, the first page a reload reads alone keeps the value the pages drawn
  were read with.
- A filter under `absent` is a switch: on sends `<property>.absent=true`, off
  sends nothing. Two filters on one property are captioned by operator, the
  `absent` one with `operatorAbsent` (`Manager is`, `Manager not set`).
- A bar with a search draws it first, in the placements that draw controls: a
  typed box labelled by the text `searchFilter`. It is held under `search` in
  the bar's state (`_telo.f.<key>.search` in the address), sent as `search=<text>`,
  and follows `apply`, Reset, defaults and `pinned` as any filter does; under
  `summary: chips` it is a chip worded by `searchChip`. A preset that sets a
  `search` is active exactly while the bar holds that search and the preset's
  values. A bar reads `show`, `controls` and `summary` from the placement it
  draws — its `compact` one below the breakpoint. A placement this renderer
  does not draw is drawn as the bar above the content.
- `Ui.SearchBoxPlacement` is drawn as one `search-box`: a chip (`search-token`)
  for the search and for each filter holding a value, in the bar's order,
  then the `search-input` — the [`Combobox`](controls-abi.md#combobox) control,
  so a theme set's layer stack draws the list too. The list is sectioned:
  presets and fields for an empty box; for typed text the search
  (`searchChip`), a `filterChip` entry per field the text can be a value for
  and the fields it begins; after a field prefix (`status:`) that field's
  values, checkable under `in` with the held ones checked. A relation's
  records come through its `search` after the typing pause, and under
  `values: present` only the values the facet request answers, with counts, under
  the bar's search. Text of the form `<property><operator><value>` is read
  as a token by the [typed-token conformance rows](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/):
  Enter commits it as one chip that replaces what its filter held. One that
  cannot be a value stays as text, with `data-reason` on the `search-box`,
  and sends nothing. The focus never leaves the input: arrows move the
  highlight (the first entry starts highlighted), Enter takes it, Escape
  closes the list, and Backspace in an empty box removes the last chip, which
  clears that filter or the search. Presets and fields are offered in the list,
  so no `filters-presets` is drawn; under `apply: button` the Apply button
  stands beside the box.
- Edit, delete and the pager are icon buttons; each is named for a screen
  reader and shows that name on hover and on keyboard focus.
- A value whose model property declares `format: uri` or `uri-reference` is
  drawn as a link showing the value, in a table layout's cell, in a `list` node and
  in a `value` node. The value must be an address [a `link` node may
  hold](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/): an app-relative path, which leads
  under the application's mount as a `link` node's does, or one starting
  `https://`, `http://` or `mailto:`. Anything else — `//host/x`,
  `javascript:…`, a path with a tab in it — is shown as plain text. A link
  to a page of the application moves within it. Any other — a file served
  under the mount (`/files/report.pdf`), another site, a mail address —
  carries `target="_blank"` and `rel="noopener"`, so it opens beside the
  application and what the page holds stays.

### Row actions

A listing's [`rowActions`](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) — and a `list`
node's, drawn the same way in a last cell of each row — are text buttons in
each row, showing each action's label in the order declared, before edit and
delete. A [`button` node](#buttons) and a markdown node's
[annotations](markdown.md#annotations) run their bound actions the same way.

- Written `rowActionsDisplay: menu`, or `auto` where the listing's own width
  does not give the buttons room, they are folded with edit and delete into
  one `row-menu` button per row opening a `Menu`; an action whose condition
  does not hold is a disabled entry whose hint is its `disabledText`. `auto`
  is judged once for the listing, in the container the records are drawn in
  and never the viewport, before the page is painted and again whenever that
  container is resized or the records or actions change.
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
  — the action's fields its inputs do not bind — under the title, each the
  control a form derives for the property. Its button sends what the fields
  hold together with the bound record, which is never drawn; Enter in a field
  does the same. The two make one record, held whole to the input model before
  anything is sent: a value it refuses marks its field, a property it refuses
  that no field enters — a required input whose binding read nothing — is
  named under the fields, and nothing is sent. What was entered is kept until
  the dialog closes, and the fields the action's `state` keeps are
  [kept values](#forms) like a form's.
- Once the operation succeeds the confirmation closes, the action's `result`
  tree — when it declares one — is drawn in place of the button
  (`row-answer`), and its `onSuccess` applies. The listing then reloads every
  listing on the page over the same `basePath`, and draws the record from the
  action's answer when that answer is the record; the answer stays while that
  record's key is drawn. In a list it stays as long as the answer the list is
  drawn from.
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
  A 400 problem's issue (`data.issues`) lands on the field whose property is
  the first segment of its `pointer` after `/body` (`/body/period/from`
  reaches the date range entering `period`), worded from its `keyword` and
  `params` by the same validation texts the browser's own validation uses, and stays
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
  The stored entry is merged property by property, so an entry keeping fewer
  properties leaves the others another entry of the key keeps. Every form,
  action and open prompt mounted in the document under the same key, keeping a
  property in the same place — the address, or one store — follows a change
  another makes to it, unless it is editing a record; another tab, and a
  prompt opened later, sees it when it next mounts: `author` entered in one
  action's prompt opens the next prompt of the key holding it.

## Actions

An [`action` node](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) is a form with one button, and
below it what the operation answered.

- The fields are a form's: the same controls, derived the same way, and the
  same check in the page before anything is sent. The button shows the
  action's `label`.
- A press sends the action's `request`: its `method` to its `target`, resolved
  over `input` and put under the mount (mounted at `/admin`, a target
  `/api/reports` is sent to `/admin/api/reports`). `POST`, `PUT` and `PATCH`
  send `content-type: application/json` and the entered record's properties
  that hold a value, less the ones the target `consumed`; `{}` when none
  remain. `DELETE` sends no body and no content type. A target that does not
  resolve sends nothing and draws the `failure` tree with
  `ERR_UI_ADDRESS_UNRESOLVED`. A field holding nothing is left out; a checkbox
  is always `true` or `false`.
- Every press clears the last answer, and the form takes no other press until
  the operation answers. A `serial` action's presses on the page — its form's
  and its rows' — are sent one after another, in the order they were made.
  The fields keep what was entered, whatever the answer.
- A success draws the `result` tree (`action-result`) over `result`, the
  record sent as `input` and what the form holds now as `values`. Its body is
  read only when that tree, `onSuccess.navigate` or an `onSuccess.refreshes`
  entry reads `result`, and must then be a JSON object the declared answer
  model accepts; any other body, an empty one (a `204`) included, is a failure
  `ERR_UI_RESPONSE_INVALID`. A 2xx nothing reads is a success whatever it holds.
- Anything else draws the `failure` tree (`action-failure`) over `error` —
  `status`, absent when nothing answered; `code`, the problem body's `code`,
  else `ERR_UI_UNAUTHORIZED` for a 401, `ERR_UI_FORBIDDEN` for a 403 and
  `ERR_UI_REQUEST_FAILED` for anything else; `message`, its `detail`, else the
  renderer's own text for the status — `input` and `values`. A 400 also marks
  the fields its `data.issues` name, each worded from its `keyword` and
  `params` by `ui`'s validation texts, every other issue under the fields.
- After a success the resolved target path and each resolved
  `onSuccess.refreshes` path are announced (an entry that does not resolve is
  skipped and reported in the console), and every reader reading exactly one
  reads again ([invalidation](urls.md#invalidation)). `onSuccess.navigate`
  moves the page: within the application to an address a declared page opens, by a full load to
  any other app-relative address, by replacing the page for an `https://`,
  `http://` or `mailto:` one. An address that does not resolve navigates
  nowhere.
- The drawn answer is cleared when a property `clearAnswerOn` lists changes.

### Buttons

A [`button` node](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) is a `button` part labelled with its
action's `label`, drawn as its `button` display says — text, a glyph beside its
text, or a glyph alone named by `aria-label` — and styled by its `style`. A
press runs the action as a [row action](#row-actions) does, with the inputs it
binds read over the roots in scope when it is pressed: at once, or through its
`confirm` question and its `prompt`. Until it is answered the button is
disabled and carries `data-state="submitting"`; a success draws the action's
`result` tree in its place (`row-answer`) and applies `onSuccess`, and a
failure draws the `failure` tree beside it (`row-failure`), or in the open
confirmation. Its `enabled` disables it while its condition does not hold, with
`disabled-text` beside it.

## Times

A [`time` node](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/), and a `list` column of `type: time`, draws a
`time` part. A value shaped as a date (`2026-11-05`) or a date-time (RFC 3339)
is a `<time>` whose `datetime` is the machine-readable time — a date-time in
UTC. `relative: true` draws it relative to now in the page's language
(`3 hours ago`, `yesterday`, `in 2 weeks`; a date by calendar days in the
viewer's time zone), its exact date and time in `title`, and draws it again
every minute while it is shown and the document is visible, and on the
document's return to view. `relative: false` draws the date, or the date and
time in the viewer's time zone, in the page's language. A value of any other
shape is drawn as its text in a `span`, and nothing is drawn for no value.

A `list` node's `rowStyle` is on each `table-row` as `data-style` and a
column's `style` on each of its `table-cell`s, both read over `row` and the
roots the list is drawn under.

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
A listing whose `layout` or `compact` is a component built for another than
the [layout contract](layouts-abi.md) is replaced the same way, as a whole.

## Authentication

The application adds none. The renderer sends the page's same-origin
credentials with every request; put a guard on the mount or on the API to
require them. A 401 or 403 is shown as an `error` node where it happened —
`ERR_UI_UNAUTHORIZED` / `ERR_UI_FORBIDDEN` — for the page when a document was
refused, for the one listing, form or action when a collection or an operation
was. Any other failed request is `ERR_UI_REQUEST_FAILED`, with the HTTP status
in its message; a form's or an action's 400 is shown on its fields instead.
