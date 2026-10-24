# UI showcase — everything a declarative screen can do

One application that tours the declarative UI, page by page. The screens are
declared, not programmed: the only browser code is four small components the
Components and Themes pages place. Each page covers one area, and every
demonstration carries a muted line saying what it shows. The data is a small
studio — its team, people, projects, tasks, the requests and bookings its
forms send, and comments on tasks — in SQLite, served by `crud` and routes of
its own, with real sessions behind a sign-in gate. Every text is written in
English and translated into fourteen languages: German, Spanish, French,
Italian, Dutch, Polish, Portuguese, Turkish, Russian, Ukrainian, Hindi,
Japanese, Korean and Chinese (Simplified).

## Run

```sh
pnpm run telo ./examples/ui-showcase/telo.yaml
```

Then open <http://127.0.0.1:8150>, and choose a language from the header's
Language menu — or set the browser's language to one of them — to see it
translated. `PORT` overrides the port and `DB_FILE` the database
file, `./showcase.db` in the working directory by default; a fresh file is
created and seeded on the first start, and a seeded row edited by hand is
restored on the next.

The UI modules (`ui-lucide` included), `crud`, `font`, `http-server`, `sql` and
`sqlite` are imported from this workspace by relative path, so the example runs
from a checkout.

## Four mounts of one design

| Mount | Theme |
| --- | --- |
| `/` | the built-in look, the example's own `showcase.css`, and a brand chosen per request: with the cookie `showcase-brand=acme` (set by `/api/brand?set=acme`, cleared by `?set=none`) the Acme tokens apply, without it the theme's own |
| `/radix` | `UiReactRadix.theme` |
| `/brand` | the example's own theme from `brand/` — Radix's controls, `brand.css` and token values of its own — under a brand of one token set that serves the bundled Inter typeface |
| `/sidebar` | the built-in look and `showcase.css`, its navigation in a sidebar instead of the header, and its pages at full width beside it (`pageWidth: full`) instead of the theme's centred column |

All four place the same pages. Each page's content is one `Ui.View`, and
each page one `Ui.Page` placing it, declared once in its `pages-*.yaml`; every
application lists the pages by reference, so the four page bodies are
identical. Three pages of `/` are pages of its own (`rootOverview`,
`rootConditions`, `rootThemes` in `telo.yaml`), carrying nodes beside the view,
because a view is resolved once at start and reads neither the request nor the
page's own query: the overview's nodes evaluated per request, the conditions
page's own `query`, and on the themes page the links to the other two mounts
and the brand switch — a link resolves under the mount it is drawn in, so only
the root application reaches the others.

Every application draws one navigation tree (`UiReact.App.navigation`), naming
its pages by reference: Overview, a **Building blocks** group holding
Conditions, Data, Tables, Filters and an **Input** group inside it (Forms,
Actions), then Components, CRUD and Themes. Every entry and group carries an
icon, declared once in `telo.yaml` and shared by the four applications: a
Lucide glyph (`UiLucide.Icon`), and for Overview the example's own mark
(`Ui.FileIcon` over `icons/mark.svg`) — each drawn in the colour of its entry's
text, so the current one takes the theme's current colour. Above `compactBelow` it is a menu
bar whose groups open as a dropdown and a submenu; below it, a menu button
first in the header opens the tree in a drawer from the start edge.

`/sidebar` draws the same tree with `Ui.SidebarNavigation`: a column beside
the page whose groups open in place, several at once, and a toggle collapsing
it to a rail of each entry's icon, whose groups open beside it. Which
groups are open and whether it is collapsed are kept in local storage, so a
reload finds it as it was left. Below `compactBelow` it is a
`Ui.TabBarNavigation` along the bottom edge showing four tabs — Overview, the
Building blocks group, Components and More, which holds CRUD and Themes — a
group's tab and More opening their entries in a bottom sheet.

Every application draws the same header around its title and navigation
(`UiReact.App.header`), on one row while the window is wider than
`compactBelow`: the example's mark before the title, and after the navigation
two `menu` nodes. **Language** offers every language the showcase speaks,
each named in its own language, each `/api/lang?set=<tag>` under the mount: it
sets the cookie `showcase-lang` when the tag is one the translator has a
catalog for or English (or clears it for any other value) and goes back to the page it was pressed on —
the `Referer`'s path and query when the `Referer` is of the request's own
origin, the mount's home otherwise.
**Theme** offers the four mounts' home pages — another mount's by an absolute
address built from the request's `Host` and `X-Forwarded-Proto` (the function
`Self.origin`: the first scheme a proxy chain lists, read as `http` unless it
is `http` or `https`), since an app-relative link resolves
under the mount it is drawn in — and on the root application the brand
switch, each of its two items delivered only while it changes something. The
language in effect is one rule, the function `Self.chosenLanguage`: the
cookie first, then the `Accept-Language` negotiation, then English. Each
application's `lang` calls it, and so does each language item's `style`, so
the language in effect is the one marked `strong` — the current choice —
whichever decided it; the current mount is marked the same way. The language
names are written in their own language and left untranslated. The language
and brand cookies last a year. None of the example's cookies is `Secure`,
because it is served over plain http locally; a deployment behind TLS adds it.

The pages' request paths are app-relative too: a reader, a table, a form, an
option source, an action and the task desk component read and write `/api/tasks`
under the mount they are drawn in. So
the server serves the API — the guarded `/api/private` routes, the three
collections and the other routes — under `/`, `/radix`, `/brand` and `/sidebar` alike,
every guarded mount behind the one session check, and the files under each
mount the same way — the language switch, `/api/lang`, included. Only the
brand switch, `/api/brand`, is the root's alone.

## Files

| File | Holds |
| --- | --- |
| `telo.yaml` | the application, the four `UiReact.App` mounts with their header and navigation, the navigation's icons, the root's own overview, conditions and themes pages, the logo view they share, the `Callout` composite kind, the session check, the three collections, the server serving the API under each mount, the Inter family the brand serves |
| `data.yaml` | the SQLite connection, schema, tables with their seed rows, and the projects, tasks and people `Crud.Model`s |
| `api.yaml` | the routes `crud` does not give and the shapes they share with the pages: record reads, the task board, the tag action, the forms' writes and lists, every action of the actions page, the session, the language and brand switches, the language rule the applications share (`chosenLanguage`), and the request origin and redirect target rules (`origin`, `sameOriginTarget`) |
| `translator.yaml` | the translator, listing one catalog per language |
| `translations/` | one `I18n.Catalog` per language, each file named by its language tag (`pl.yaml`, `ja.yaml`, …) |
| `pages-*.yaml` | one view per page and the `Ui.Page` placing it, with the resources only that page uses (the tables page's two task forms and page surface, the filters page's task table, the forms page's team and project option sources, the actions page's assign action) |
| `showcase.css` | the `/` and `/sidebar` applications' stylesheet |
| `components/` | a library of the example's own: four browser components written in TSX (`nodejs/src/components.tsx`, with the stylesheet they import) against the `ui_react-1` host, built by the kernel and published as `Ui.ComponentExport`s — `taskDesk`, `priorityMeter`, `tokenSheet` and `typefaceSamples`. Its `nodejs/package.json` exists only to type-check the sources |
| `brand/` | a library of the example's own exporting the `/brand` theme: `brand.css`, which styles every part of the styling contract, the token values, and Radix's controls |
| `files/` | the handbook and the image served under each mount |
| `icons/` | the example's own mark as a glyph, the Overview entry's icon |
| `fonts/` | Inter 4.1, under the SIL Open Font License (below) |

## Pages

| Path | Shows |
| --- | --- |
| `/` Overview | every node type and style, links of each address form, images and SVG; values presented by their schema, a list, texts with plurals and values over the team record; style rules on the projects table, one word told apart by context in two column headers and in two nodes' own texts; an inline view and the example's own composite kind; tabs whose chosen tab is in the page's address; on `/`, nodes evaluated per request and an error node |
| `/conditions` | `when` against `shown`, a placement's condition around a composite's own, every keyword of a condition over a project's summary, missing against null, query parameters set by links, and a button enabled by its form's values |
| `/data` | a reader whose parameter follows the address, with loading and failure trees and a nested reader; readers that fail three ways; a reader read again on focus; a sign-in gate over real sessions |
| `/tables` | columns derived from the model and written by hand, sorting, style rules on rows and cells, members nested behind references, the pager, a filter from the page address and a fixed one, and create, edit and delete opening on every kind of surface — dialogs of each size, drawers from each edge, popovers, in line, panels and a page of its own — with addresses, compact replacements, `afterSubmit` and `unsaved` |
| `/filters` | nine filter bars over the tasks: every placement (above, aside at either edge, folded open and closed, an overlay in a dialog, a drawer and a popover), every value of `show`, `controls`, `apply` and `summary`, every control a filter is entered with, presets, pinned filters and defaults, and state kept in the address, in local storage, in session storage and in both |
| `/forms` | a form deriving a control for every type of property, with a write-only one never kept and its values kept in the address and local storage; the same record with every input control chosen by hand, kept in session storage; a booking form choosing from the projects and the team — a select list and options side by side with hints and More, pickers in a dialog, a drawer and a popover with search and links, a source narrowed by another field and a default labelled by `in` — with a date range, groups, a group and a field shown on a condition; live validation, and the server's refusals landing on a field; lists of what each form wrote |
| `/actions` | a bare button; an estimate with grouped fields kept in the address, its answer drawn as sentences, a date and a list; a failure tree of an action's own, and an answer its output model refuses; successes moving to a page by a fixed address and by the answer, to an https address, loading a served file, and going nowhere for an address the rule refuses; a move reading a reader and a table again; comments sent one after another, enabled by the form and clearing their answer; a manager-only action refused with 401 and 403, and one whose route never answers; row actions — plain, confirmed, prompting, enabled per row, and a plain confirmation whose inputs come from the row and the table's query — on tables of tasks and a list of comments |
| `/components` | a component of the example's own using every field of the host — where the page is, a panel kept in the address, `navigate` and an anchor from `href`, an https address refused, `fetch` reading counts and adding a task, `notifyChanged` reloading the table below, `onChanged` counting every change, a toast in a layer of its own — and a component drawing a table's priority cell; their stylesheet in the `telo.component` layer |
| `/crud` | a `Crud.Ui` over the tasks collection: a filter bar beside the table showing chosen filters as chips and sharing its state key with a bar on `/filters`, create in a drawer kept open for the next record, edit in an addressed panel asking before unsaved input is dropped |
| `/themes` | what the four mounts are; every design token as the mount's theme and brand give it, read live with a sample; the body and heading typefaces in each face, with the faces the application serves — Inter's four on `/brand`; on `/`, links to the other two mounts and the brand switch |

## Routes

| Method | Path | Answers |
| --- | --- | --- |
| `GET` | `/api/projects` | the projects collection (`Crud.Resource`): paged, sorted, filtered by what the model declares, `code.in` included |
| `GET` `POST` `PUT` `DELETE` | `/api/projects/{id}` | one project; a refused body is the 400 validation problem |
| `GET` | `/api/tasks` | the tasks collection (`Crud.Resource`): paged, sorted by title, status, priority, estimate or due date, and filtered by every operator — `contains`, equality, `gt` / `lt`, `gte` / `lte`, and `in` over status, label and assignee |
| `GET` `POST` `PUT` `DELETE` | `/api/tasks/{id}` | one task; a refused body is the 400 validation problem |
| `GET` | `/api/people` | the people collection (`Crud.Resource`): searched by `name.contains`, narrowed by `role` and `active`, chosen values labelled by `email.in` |
| `GET` `POST` `PUT` `DELETE` | `/api/people/{id}` | one person |
| `GET` | `/api/task-board` | every task with its assignee and project nested in it, paged under the collection contract with an offset cursor; no filter or sort |
| `GET` | `/api/team` | the team record and its projects under way, each as the projects collection reads it |
| `GET` | `/api/project-summary?code=` | one project's lead, member count, tags, note and codename; 404 for an unknown code |
| `GET` | `/api/project-people?code=` | the people on one project; 404 for an unknown code |
| `POST` | `/api/tags` | tags TEL-42: 201 with the tag count, 409 for a tag it has, 400 for one the pattern refuses |
| `GET` | `/api/clock` | the server's time |
| `GET` | `/api/session` | whether the cookie names an open session |
| `POST` | `/api/session/signin` | opens a session for an active member: an http-only cookie; 400 on the field for an unknown e-mail, 403 for a former member |
| `POST` | `/api/session/signout` | deletes the session and clears the cookie |
| `GET` | `/api/private/account` | the session's person; 401 with no body without a session |
| `POST` | `/api/private/ping` | 200 with a session, 401 without |
| `POST` | `/api/private/pause` | pauses a project for a manager; 401 with no body without a session, 403 with no body for anyone else, 404 for an unknown project, 409 for one not running — worded in the language the applications answer in (`Self.chosenLanguage`), with `Content-Language` |
| `GET` | `/api/brand?set=acme\|none` | sets or clears the brand cookie and goes to `/themes` |
| `GET` `POST` | `/api/requests` | the five latest requests; a request stored, 400 on `title` for a title another request has |
| `GET` `POST` | `/api/bookings` | the five latest bookings; a booking stored, 400 on `period.from` / `period.to` for a reversed period or one past a year, 404 for an unknown project |
| `POST` | `/api/unblock` | unblocks every task of TEL-42 |
| `POST` | `/api/estimate` | a project's open hours by label, in weeks at a pace and the date they end; 404 for an unknown project |
| `POST` | `/api/assign` | gives a task to a member: 400 on `assigneeEmail` for nobody or a stranger, 404 for an unknown task, 409 for a former member |
| `POST` | `/api/task-status` | moves a task to a status; 404 for an unknown task, 409 when it is already there |
| `GET` | `/api/task-counts?code=` | how one project's tasks stand, TEL-42 by default |
| `POST` | `/api/project-page` | the page listing a project's tasks; 404 for an unknown project |
| `POST` | `/api/homepage` | the team's homepage |
| `POST` | `/api/team-links` | the team's handbook and mirror addresses |
| `POST` | `/api/loop` | 307 back to itself, so a browser gives up and the caller gets no answer |
| `GET` `POST` | `/api/comments` | the ten latest comments, pinned first; a comment added, 404 for an unknown task |
| `POST` | `/api/comments/pin`, `/api/comments/delete` | pins or deletes a comment; 404 for an unknown one |
| `POST` | `/api/comments/edit` | rewrites a comment; 400 on `body` when the new text is left out |

## Tests

Each test that runs the application gives it a database file of its own under
`./.telo` (`UI_SHOWCASE_TEST_DIR` overrides the directory).

| Test | Port | Asserts |
| --- | --- | --- |
| `tests/serves-the-showcase.yaml` | 8151 | the application documents of all four mounts — `/sidebar`'s placement with every default filled — in English and Polish and with the brand cookie, the derived theme's tokens and the brand's Inter faces, and every page document — the overview's nodes, conditions, readers, the tables' columns and every surface spec, every filter bar's policy and fields, every form's fields, option sources, groups and state, every action's fields, answer trees, `onSuccess` and row actions, the components with their module and stylesheet served, the admin screen's bar, forms and surfaces, and the themes page with the root's links and brand badge — `/radix`, `/brand` and `/sidebar` placing the same views |
| `tests/answers-every-route.yaml` | 8152 | the project, record, tag, session and brand routes against the real database: paging, sorting, `in`, a create / read / replace / delete round trip, the 400 validation problem, a 401, the session and the brand switch; and under `/radix`, `/brand` and `/sidebar`, a reader's route, a collection listing, an action's route, the guard's 401 and no brand switch |
| `tests/tables-and-filters.yaml` | 8153 | the routes the tables and filter bars call: the tasks a page at a time by cursor, sorted both ways, every filter operator the bars send with `in` repeated, a refused sort and filter, a create / read / replace / delete round trip with refused bodies, and the task board's nested rows and cursor |
| `tests/forms-and-actions.yaml` | 8154 | the routes the forms and actions call: both forms' writes with the server's refusals, the option sources paged, narrowed by a field, searched and labelling by `in`, every action's success, 400 validation problem and other problems, the answer the days action refuses, and each row action's route |
| `tests/brand-theme.yaml` | none — it starts no application | the `/brand` theme meets the renderer's contract (`UiReactConformance.CheckTheme`): every part styled, no reserved property set, every token given a value and read, every scene drawn with its controls |
| `tests/components-crud-themes.yaml` | 8156 | the routes the last pages added: the handbook and mirror addresses, the route that never answers, and pausing a project — 401 without a session, 403 with no body for a member who is no manager, the pause, a 404, and a 409 in English and in Polish with `Content-Language` |

The application itself defaults to port 8150.

```sh
pnpm run telo ./examples/test-suite.yaml --include 'ui-showcase/tests/*.yaml'
```

## Out of scope

- Check-time refusals — every `UI_*`, `CEL_*`, `SCHEMA_*` and `ERR_*` code
  listed as a refusal or a failure. An application that runs cannot contain
  them.
- A control set of the example's own. Controls are shown by reusing
  `UiReactRadix.controls`.

## Coverage

Every line of the UI capability checklist, and the page that shows it — or
why it is not shown.

| Line | Capability | Where |
| --- | --- | --- |
| A1 | `title` | every mount |
| A2 | `words: !ref Ui.words` | every mount. A custom `Ui.Words` set is not shown: the example words the renderer in every language it speaks by translating the exported set through its catalog |
| A3 | `theme`: the default, Radix's, one of the example's own | `/`, `/radix`, `/brand`. The example's own theme is declared in `brand/` and named by `!ref`, not written inline at the application, so `tests/brand-theme.yaml` checks the very theme the mount draws with |
| A4 | `tokens` as one `Ui.DesignTokens`, inline | `/brand` (the Inter typeface) |
| A5 | `tokens` as a `{ tokens, when }` list over a cookie | `/`, switched on its Themes page |
| A6 | `stylesheets` | `/`, `/sidebar` (`showcase.css`) |
| A7 | `compactBelow` | every mount |
| A8, A9 | `translator`, `lang` negotiated from `Accept-Language`, `Vary` | every mount |
| A10 | ten pages, one nav link each | every mount; the path refusals are out of scope |
| A11 | `pages[].query` | `/conditions` on `/` |
| A12 | `when` and text per request; an error node for an invalid computed `href` | Overview and Themes on `/`; `REF_SLOT_COMPUTED` is out of scope |
| A13 | mounts at `/radix`, `/brand` and `/sidebar`; files and the API served under each mount, where each application's `source` paths are read; `fetch` paths from the origin | `telo.yaml`, `/components` |
| A14 | `font.*` tokens with faces served as `@font-face` | `/brand`, shown on `/themes`; `ERR_UI_FONT_FORMAT_UNKNOWN` is out of scope |
| A15 | a guard answering 401; 401 and 403 drawn as `ERR_UI_UNAUTHORIZED` / `ERR_UI_FORBIDDEN`, anything else as `ERR_UI_REQUEST_FAILED` | `/data`, `/actions` |
| B16–B21 | box, stack, columns, text styles, badge, links of each address form, image, SVG | Overview |
| B22 | values presented as uri, uri-reference, mailto, date, date-time, boolean, enum label, refused address | Overview |
| B23 | a `list` with default and written headers and a column `shown` | Overview, `/actions` |
| B24 | composites by `!ref` (each page's view) and inline | every page |
| B25, B26 | `style` lists, `when`, `shown`, both on one node | Overview, `/conditions` |
| B27 | style rules: `rowStyle`, column `style` with `default` | Overview, `/tables` |
| B28 | a placement's `shown` around a composite's own | `/conditions` |
| B29, B30 | the address rule and the error node | Overview, `/actions` (the mirror) |
| C31 | `{$name}` placeholders | every page |
| C32 | one word told apart by context | Overview (two column headers, a badge and a link), `/actions` (verbs) |
| C33, C34 | plural selection, `Ui.BoundText` over data | Overview, `/data`, `/actions` |
| C35 | texts that take no values: action labels, column headers, group labels, preset labels | `/actions`, `/tables`, `/forms`, `/filters`; the refusal is out of scope |
| C36 | `disabledText` and `confirm` | `/conditions`, `/actions` |
| C37 | schema titles and enum labels, `x-telo-text-context` | Overview (`plan`), every model drawn |
| C38, C39 | the renderer's words, translated, plurals included | `translations/`, every mount |
| C40 | check codes | out of scope |
| D41–D43 | conditions, every `Ui.Match` keyword, missing against null | `/conditions`; the codes are out of scope |
| D44 | hidden content stays mounted and reads nothing | `/data` (the sign-in gate), `/forms` (a field and a group shown on a condition) |
| D45 | roots `data`, `error`, `query`, `values`, `result`, `input`, `row` | `/conditions`, `/data`, `/forms`, `/actions` |
| D46 | query parameters: a string, a list, a pattern | `/conditions`, `/data`, `/actions` |
| D47 | `Ui.Enablement` with `disabledText`, on an action and on row actions | `/conditions`, `/actions` |
| E48–E50 | `Ui.View`, a view providing no node, the `Callout` composite kind, nodes carrying their assets | Overview, `/conditions`, `/components`, `/themes` |
| F51–F55 | readers: params from `query`, `loading`, `failure`, `reloadOn` focus and unauthorized, a refresh by an action, 404 / 401 / refused answers, a sign-in gate, nesting | `/data`, `/actions` |
| G56–G60 | the collection contract: declared query with every operator, paging, sorting, `in`, the 400 validation problem, item routes; a `Crud.Model` at every `collection` slot | `/api/projects`, `/api/tasks`, `/api/people`, `/api/task-board` |
| G61 | labelling chosen values by `in` | `/forms` |
| H62–H64, H66–H70 | tables: derived and written columns, headers, presentation by type, sorting, members behind references, `rowStyle` and cell style rules, `pageSize` and the pager, `source.filters` from `query` and fixed, `create` / `edit` / `delete` | Overview, `/tables`, `/filters`, `/crud` |
| H65 | columns, a component as a `cell` | `/tables`, `/components` |
| H71 | a table's `query`, read by `source.filters` and by a row action; `rowActions` | `/tables`, `/actions` |
| H72 | every table over a `basePath` reloading after a write | `/tables`, `/components`, `/crud` |
| I73–I78, I81–I84 | every surface kind with every key, compact replacements, `afterSubmit`, `unsaved`, surface attributes | `/tables`, `/crud` |
| I79 | surfaces named by `!ref` and written inline | `/tables`. A surface kind of the example's own is not shown: it is an extension, and none of the pages needs one; the refusals are out of scope |
| I80 | addressed surfaces, opened cold from a link | `/tables`, `/crud`. A row with an empty key is not shown: every key here is a database id |
| J85–J93, J95 | forms: derived fields and controls, hints and defaults, what is sent, live validation, a 400 problem's issues on a field, fields and groups shown on a condition, groups, kept state, write-only properties | `/forms` |
| J94 | form rules | out of scope |
| K96–K102 | every field kind and control, option sources | `/forms`, `/actions` |
| K103 | a field kind of your own | not shown: it is an extension, and the design gives it no page |
| L104–L113 | actions: fields, groups, state; bare buttons; `result` and `failure` trees; an answer the output model refuses; `navigate` to a page by a fixed address and by the answer, to a served file, to https, and nowhere for an invalid one; `refreshes`; `concurrency: serial`; `clearAnswerOn`; 400, 401, 403, 404, 409 and no answer; one shape for the route and the action | `/conditions`, `/data`, `/actions` |
| L114 | check codes | out of scope |
| M115–M121 | row actions on a table and a list: by `!ref` and inline, inputs from the row, the table's `query` and fixed, `confirm`, `prompt` with fields and as a plain confirmation, `enabled` per row, answers in place of the button | `/actions` |
| M122 | check codes | out of scope |
| N123–N136 | filter bars: derived and listed fields, every control, two bounds under one label, presets, pinned filters, defaults, every `show` / `controls` / `apply` / `summary` value, every placement, state in the address, local and session storage and both, one key shared by bars on two pages | `/filters`, `/crud`. Storage the browser refuses cannot be arranged by a page |
| N137 | filter rules | out of scope |
| O138–O141 | a library's browser entry and `Ui.ComponentExport`s, `Ui.Component` on a page and in a cell, every field of `useHost()`, anchors, a layer of a component's own, the `telo.component` stylesheet | `/components`, `/themes`; the error codes are out of scope |
| O142 | the streaming chat and upload recipes | not shown: the design gives them no page; the desk on `/components` uses the same `fetch` and `notifyChanged` |
| P143 | every design token | `/themes`, `/brand` |
| P144 | `UiReact.Theme` with `tokens`, `stylesheets` and `controls` | `brand/` (the `/brand` theme) |
| P145 | a control set of your own | out of scope |
| P146 | `UiReact.defaultTheme` | `/` |
| P147 | Radix's theme, and its controls reused by a theme of the example's own | `/radix`, `/brand` |
| P148 | the cascade layers | `/components` (`telo.component`), `/` (`showcase.css`, unlayered) |
| P149, P150 | the styling contract and `UiReactConformance.CheckTheme` | `brand/brand.css`, `tests/brand-theme.yaml` |
| Q151–Q153 | fourteen catalogs with plurals, the translator, the negotiator | `translations/`, `translator.yaml`, `telo.yaml`, every mount |
| Q152, Q154 | the translator in an API route, answering in the caller's language | `/api/private/pause` (from `/actions`) |
| R155, R156 | `Crud.Model`, `Crud.Resource` | `data.yaml`, `/api/projects`, `/api/tasks`, `/api/people`; the rules are out of scope |
| R157 | `Crud.Ui` with a filter policy and `create` / `edit` surfaces | `/crud`; its expansion, written by hand, on `/tables` and `/filters` |
| S158, S159 | the shell, the application and page documents | every mount |
| S160 | the event stream | every mount |
| S161 | the `_telo` address and storage keys | `/tables` (surfaces), `/filters` (bars), `/forms` and `/actions` (kept values) |
| S162 | `notifyChanged` local to the document | `/components` |
| S163 | same-origin credentials, icon buttons with tooltips | every table |

## Inter

The faces in `fonts/` are Inter 4.1 by Rasmus Andersson
(<https://rsms.me/inter/>), licensed under the SIL Open Font License 1.1
(`fonts/OFL.txt`) — not under the MIT license of the rest of this example.
