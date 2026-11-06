---
status: draft
priority: medium
depends-on: [2026-11-05-ui-press-and-record-detail.md]
packages: [analyzer/nodejs, modules/ui, modules/ui-react, modules/crud-ui, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
---

# Page sets, and screens generated from collections

## Problem

`CrudUi.Admin` turns one SQL-backed collection into one composite — filter bar, listing, forms, delete — that the author still places on a hand-written `Ui.Page`, adds to `pages:`, and names in `navigation:`. An admin over eight tables is eight pages, eight navigation entries and eight composites written out. For a collection not served by `crud`, every page, listing, bar and form is written by hand.

A library also cannot ship pages at all: a module offering an account area or a settings screen can export composites and views, but the importer must declare each page, its path and its menu entry.

Home Assistant builds its default dashboard from the registries with a `strategy:` — the screens exist the moment the data does. Telo has the parts (collections, presentations, listings, templated definitions with `!for-each`), but no seam a generator can deliver pages through.

## Solution

**`Ui.Pages` — pages and their menu, as one resource.** `Ui.Pages` is an abstract `Telo.Provider` whose reading is `{ pages, navigation }`: a list of `Ui.Page` references and a list of `Ui.Navigation` items over those pages. `Ui.PageSet` is its concrete kind, written with those two fields. A library exports a set as an instance (`exports.resources`), so "an account area" is one import and one list entry.

**Placing a set.** `UiReact.App` gains `pageSets`, a list of `Ui.Pages` references beside `pages`. The App serves every set's pages as its own. `navigation` gains `{ type: set, set: !ref <set>, when? }`, which draws the set's navigation items in its place, their own `when`s applying beneath the entry's; a `set` entry naming a set `pageSets` does not list is `UI_NAVIGATION_SET_UNPLACED`. With `navigation` omitted, the App's pages contribute one entry each, then each set its own items, in list order. Sets do not nest: a set's pages are `Ui.Page`s.

**The App's rules see through a set — including a generated one.** The App's page rules (`UI_PAGE_PATH_DUPLICATE`, `UI_NAVIGATION_PAGE_UNROUTED`, the new `UI_NAVIGATION_SET_UNPLACED`) resolve `pageSets` into each set's `pages` and `navigation`. For a set produced by a template, the analyzer is extended once, generically: **a rule's `resolve:` that reaches a templated resource continues into the body entry its dispatch verb (`provide:`) names, as that consumer instantiates it** — the per-consumer instantiation `telo check` already performs for rules reading across body entries. So a generated page colliding with a hand-written one is refused before the app runs, exactly as two hand-written ones are. At start the App reads each set's published reading and raises the same codes as `ERR_` twins. A library's set paths are the library's: a collision with the importer's pages is refused, and a library meant to be placed under a prefix the importer chooses ships a templated set kind taking it, as `Ui.CollectionPages` takes its paths.

**`Ui.CollectionPages` — one page per collection, generated.** A templated kind extending `Ui.Pages` (in `ui`, renderer-neutral). It takes `collections`, a map whose keys name the pages, each entry:

| Key | | |
| --- | --- | --- |
| `presentation` | required | the `Ui.CollectionPresentation` the page lists; its `detail` opens each record |
| `model` | required | the row shape |
| `title`, `path` | required | the page's title and path |
| `icon` | | the navigation entry's `Ui.Icon` |
| `create`, `update` | | write shapes; each present adds the create / edit opener with its form |
| `filters` | | a `Ui.FilterPolicy`; present, the listing sits in a filter bar of one control per collection filter |
| `layout`, `compact`, `paging` | | forwarded to the listing |

and an optional `group` (a `Text`): present, the set's navigation is one group of that name holding an entry per collection; absent, one entry per collection, in the map's written order. The body is one page family over `collections` and one `Ui.PageSet` entry listing its members (`!ref pages[each.key]`), which `provide:` names. Every optional part lives inside the one page member and is chosen with `!if`, which contributes nothing to its container when no branch holds: an opener only for an entry holding `create` / `update`, the filter bar only for one holding `filters`. A key left out reaches the listing or bar as absent, so `ui` still owns every default. For a collection not served by `crud`, the author writes the presentation and model; the page, listing, bar, forms and menu are generated.

**`CrudUi.CollectionPages` — the same over `crud`, with nothing restated.** A templated kind extending `Ui.Pages` whose entries name a `CrudUi.CollectionSource` plus `title`, `path`, `icon`, `relations`, `detail`, `filters`, `layout`, `compact` and `paging`. It generates each entry's presentation (with `relations` and `detail` forwarded whole, in the press plan's shapes) and fills `model`, `create` and `update` from the crud collection's `schemas`, wrapping a `Ui.CollectionPages`. An entry may instead name its own `presentation` — the ejected form of that one piece — which is how one entry's relations open another entry's records: a `Ui.OpenRecord` names a presentation by reference, and a generated family member cannot be named from outside its body.

**Generated pages are an expansion, not an editor surface.** As for `CrudUi.Admin`, a visual editor shows the generating resource and its entries; ejecting replaces it with the hand-written `Ui.Page`s, listings, bars and forms it expands into, which read like hand-written `ui`. The docs document that path.

Before: eight pages, eight navigation entries, eight `CrudUi.Admin` composites. After: one `CrudUi.CollectionPages` in `pageSets:` and its menu drawn by default.

## Decisions

- **A set is the generic primitive; generation is one kind built on it.** Shipping pages from a library and generating pages are the same need — something other than the application holding pages and their menu. Rejected: a generator that expands into a whole `UiReact.App`, which would tie generation to one renderer and leave libraries unable to ship pages.
- **`pageSets` beside `pages`**, not sets mixed into `pages`: a page is called per request and a set is read once at start, two different uses of a reference slot.
- **Rules see through templates by a generic analyzer rule**, not by a `Ui`-specific reader: any kind delivering resources through `provide:` benefits, and the analyzer still knows nothing about pages.
- **`Ui.CollectionPages` lives in `ui`; the crud variant in `crud-ui`.** It reads only `ui` and `data-model` kinds; the crud variant needs `crud`'s schemas, which `ui` never imports.
- **Entries are a map**, keyed by name: a key is the page member's stable identity, so reordering or inserting a collection renames no other page.
- **No per-property keys** (columns outside a layout, field lists, presets): those are the point where an author ejects, as with `CrudUi.Admin`.

Bookkeeping: docs (new `page-set.md`, new `collection-pages.md`, `navigation.md`, `page.md`, `ui-react` `app.md`, `crud-ui` new `collection-pages.md`; `docs/extend/resource-rules.md` and `docs/extend/referrer-rules.md` and the analyzer's guide for `resolve:` through a templated resource); a showcase admin area built from `CrudUi.CollectionPages` with tests under its `tests/`; the hub `build-ui` guide's admin section rewritten around it (within its 32768-byte bound), the primer, `modules/CLAUDE.md`; a ledger entry under Standard library, "A whole admin from a list of tables"; a changeset for `@telorun/analyzer` (the telo version line); `Added` fragments for `ui`, `ui-react`, `crud-ui`. `requires:` floors where the previous published CLI, run against a module's own file with the block stripped, rejects it.

## Verify

- An application with `pages: [!ref home]` and `pageSets: [!ref admin]`, `admin` a `CrudUi.CollectionPages` over three crud sources, serves `/admin/tasks`, `/admin/people`, `/admin/tags`; the header navigation shows Home and an Admin group with the three; each page lists, filters, creates, edits and opens a record's detail.
- A generated page whose `path` equals a hand-written page's is `UI_PAGE_PATH_DUPLICATE` under `telo check` and fails the run with `ERR_UI_PAGE_PATH_DUPLICATE`; the same for a library's exported `Ui.PageSet`.
- A `{ type: set }` entry naming an unplaced set is `UI_NAVIGATION_SET_UNPLACED`, pinned both ways.
- An entry with no `filters` produces no filter bar, and one with no `create` no create opener (`Assert.Equals` on the page document); `paging: more` reaches the generated listing.
- Adding a fourth entry to the map changes no other page's member identity (`pages['tasks']` unchanged) and no other page's address; the navigation follows the map's written order.
- A crud entry naming its own `presentation`, related to by another entry's `Ui.OpenRecord`, opens that record's detail from the other page.

## Example after the change

```yaml
kind: CrudUi.CollectionPages
metadata: { name: admin }
group: Admin
collections:
  tasks:
    source: !ref tasksSource
    title: Tasks
    path: /admin/tasks
    filters: { show: chosen, summary: chips }
    detail: { surface: { kind: Ui.Drawer, side: end, address: { name: task } } }
  people: { source: !ref peopleSource, title: People, path: /admin/people }
---
kind: UiReact.App
metadata: { name: app }
title: Back office
theme: !ref UiReact.defaultTheme
pages: [!ref home]
pageSets: [!ref admin]
```
