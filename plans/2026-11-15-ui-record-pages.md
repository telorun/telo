---
status: draft
priority: medium
depends-on: [2026-11-05-ui-press-and-record-detail.md, 2026-11-15-collection-partial-writes.md, 2026-11-15-ui-query-reads.md]
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/crud-ui, examples/ui-showcase, examples/chat, apps/hub, apps/authoring-agent, docs]
refinement: not-started
---

# A record's form is a page, opened like any other

## Problem

After the press plan a screen has two ways to open something over the page, and they share nothing:

- **A listing's `create` / `edit` opener** — `{ form, surface?, afterSubmit?, unsaved? }` — opens a form, in any of six surfaces, addressed by `_telo.open.<name>=<key>` (an empty value meaning a new record). Only a listing can open one: a `button`, a `list` row, a related record's label, a success, a notification cannot open the same edit screen.
- **An opened page** — `Ui.OpenPage` — opens any `Ui.Page`, in a dialog or drawer only, addressed by `_telo.open.<name>=<app-relative address>`.

The form's lifecycle (`afterSubmit`, `unsaved`) belongs to the listing that opened it, so the same form on a page of its own has none. And `Ui.Form` cannot say which stored record it edits: it writes `POST` on a page and learns the record's key only from the opener.

## Constraints

None.

## Surface

**Added**

- `Ui.Listing.create` — a `Ui.Press` (`{ to, label? }`), drawn as the listing's create button; `label` defaults to `ui`'s keyed text `create`.
- `Ui.Listing.edit` — a `Ui.Press` over `row`, drawn among each record's actions; `label` defaults to `ui`'s keyed text `edit`.
- `Ui.Form.record` — required, `{ presentation, key? }`: the collection the record belongs to, and a plain chain to the key value of the stored record the form edits.
- `Ui.Form.initialValues` — a plain chain, held to fit `model`: the record the form starts from.
- `Ui.Form.unsaved` — `confirm` (default) | `discard`: whether leaving with unsaved input asks first.
- `Ui.Form.afterSubmit` — `close` (default) | `keep` | `again`.
- Wire `form` node: `record` (`{ basePath, key }`, `key` a binding or `null`), `initialValues` (a binding or `null`), `unsaved`, `afterSubmit`.
- `CrudUi.Admin.create` / `edit` — each a `Ui.Press`, forwarded whole to the listing.

**Changed**

- `Ui.OpenPage.surface` — takes any `Ui.Surface` (a popover, an inline surface and a panel included), a `Ui.Dialog` when omitted.
- `Ui.Listing.press` — omitted, pressing a record does what `edit`'s `to` says.
- `UI_WRITE_UNDECLARED` / `UI_WRITE_SHAPE_MISMATCH` — judged on the `Ui.Form` declaring `record`, no longer on a listing.
- The leave guard — holds for every form with unsaved input, wherever it is placed.

**Removed**

- `Ui.Listing.create` / `edit` as `{ form, surface, afterSubmit, unsaved }` — `SCHEMA_VIOLATION`; the wire `listing` node's opener members with them.
- `Ui.Form.presentation` — `SCHEMA_VIOLATION`; `record.presentation` replaces it.
- `Ui.PageSurface` — an unknown kind; "in place of the page" is `Ui.Navigate`, or `Ui.Dialog` with `size: full` to keep the list beneath.
- `_telo.open.<name>=<key>` and its empty create value — an opened page's value is always its app-relative address.
- `CrudUi.Admin`'s generated forms and its `create` / `edit` `{ surface, afterSubmit, unsaved }`.

## Solution

**One way to open: a page, through `to`.** A record's create screen and edit screen are `Ui.Page`s. A listing's `create` and `edit` are presses whose destination is usually a `Ui.OpenPage`, and anything else that goes somewhere — a `button` beside a record, a related record's label, an action's `onSuccess.to`, a notification's link — opens the same page the same way. The page reached by its own address is a full page; opened from a press it is drawn in the press's surface.

**The form says what it edits.** `record.presentation` names the collection and supplies the related-record pickers. Without `record.key` the form's default submit is `POST <basePath>`; with it, `PATCH <basePath>/<key value>` — the merge patch of the properties changed since the form started, with `If-Match` under the page-wide validator rule. `key` is a chain over the roots where the form is placed (`params.id` on an edit page, `data.id` inside a query node), its type held to the collection's key property. Either write announces `<basePath>` and `<basePath>/<key value>`.

**The form says what it starts from.** An edit page reads the record with a `query` node at the item's address and places the form among its children with `initialValues` over `data`; the query's `ETag` is the validator the form's `PATCH` carries. A form starts from `initialValues` when it is drawn, and the address and its `state` store are read only where `initialValues` is absent. It starts again, the guard asking first, when the resolved address of the query its `initialValues` reads changes; a re-read at the same address keeps the form and what was typed.

**The lifecycle is the form's.** `unsaved: confirm` asks before unsaved input is dropped by anything that closes the form — its surface closing, a move to another page, another record opening in the same surface — and `discard` drops it. `afterSubmit: close` does what a `Ui.Close` destination does: it closes the surface the form's page is open in, and on a page of its own the form stays, saved. `keep` leaves it open with its values; `again` returns it to the values it started from, which on a create page is a fresh record and on an edit page the saved one, so no rule restricts it.

**Every surface, placed against what opened it.** A `Ui.Popover` is anchored to the pressed element. A `Ui.InlineSurface` is drawn in line after it — under the record in a listing, after the node elsewhere. A `Ui.Panel` is drawn beside the nearest composite holding the pressed element. Where what opened the page is not on screen — a notification, a cold load of an address naming a popover, a trigger since redrawn — and on a narrow viewport, the surface's `compact` is used, else a dialog. A page opened in a panel or an inline surface is a context of its own exactly as one in a drawer is: its own presses replace its content, its own address parameters stay in memory.

**One address scheme.** `_telo.open.<name>` holds the opened page's app-relative address. Tabs, filter overlays and tab bars keep their own values under their own names.

**Generated screens.** `CrudUi.Admin` no longer generates forms: a composite cannot add routes to an application. Its `create` and `edit` are presses the author points at pages, and the page-sets plan's `CrudUi.CollectionPages` generates those pages and the presses opening them.

**Before / after.** Before, a task's edit form opens only from its listing, and the page `/tasks/7` — if the author also wants one — is a second, hand-written screen with no unsaved guard. After, `/tasks/{id}` is one page holding a query and a form; the listing's `edit` opens it in a drawer, a link in an e-mail opens it as a page, and both save, guard and close by the form's own keys.

## Example

```yaml
kind: Ui.Page
metadata: { name: taskPage }
path: /tasks/{id}
title: Task
children:
  - type: query
    query:
      kind: Ui.Query
      model: !ref Task
      url: { path: "/api/tasks/{id}", pathParams: { id: !cel "params.id" } }
    children:
      - type: composite
        ref:
          kind: Ui.Form
          model: !ref TaskInput
          record: { presentation: !ref tasksPresentation, key: !cel "params.id" }
          initialValues: !cel "data"
---
kind: Ui.Page
metadata: { name: newTaskPage }
path: /tasks/new
title: New task
children:
  - type: composite
    ref:
      kind: Ui.Form
      model: !ref TaskInput
      record: { presentation: !ref tasksPresentation }
      afterSubmit: again
---
kind: Ui.Listing
metadata: { name: tasks }
model: !ref Task
presentation: !ref tasksPresentation
create:
  to: { kind: Ui.OpenPage, page: !ref newTaskPage, surface: { kind: Ui.Dialog, size: small } }
edit:
  to:
    kind: Ui.OpenPage
    page: !ref taskPage
    pathParams: { id: !cel "row.id" }
    surface: { kind: Ui.Panel, address: { name: task }, compact: { kind: Ui.Drawer, side: bottom } }
```

## Decisions

- **Openers are removed, not kept as a spelling over the same machinery.** A listing-only opener leaves every other site unable to open a form and keeps a second content kind beside pages.
- **Surfaces are widened, not cut to dialog and drawer.** Dropping the panel and the inline surface would lose master-detail and in-line editing.
- **`record.key` is explicit.** A form that inferred "the record I was started from" would write wherever its query happened to read.
- **`afterSubmit` and `unsaved` on the form.** They describe the form's behaviour; owned by whoever opened it, a form reached by its address has neither.
- **No manifest migration.** Rewriting an opener means creating pages and routes, which a data migration cannot do; in-repo manifests are updated and the fragments describe the break.

## Verify

- A task row's `edit` opens `/tasks/7` in a panel at `?_telo.open.task=%2Ftasks%2F7`; reloading reopens it; below the breakpoint it is a bottom drawer under the same address.
- Saving sends `PATCH /api/tasks/7` with only the changed properties and `If-Match`, closes the panel and reloads the listing; the same page reached at `/tasks/7` saves and stays.
- Closing the panel with an edit pending asks the guard's question; with `unsaved: discard` it closes at once.
- `afterSubmit: again` on the create page saves and shows an empty form; pressing `create` twice in a row creates two records.
- An `Ui.InlineSurface` on a listing's `edit` draws the page under its record; on a `button` node, after the button; a `Ui.Popover` is anchored to what was pressed, and opened cold is a dialog.
- A listing with `edit` and no `press` opens the edit page when a record is pressed.
- `record.key` reading a string where the collection's key is an integer is `CEL_TYPE_ERROR`; a form whose model falls outside `schemas.update` is `UI_WRITE_SHAPE_MISMATCH` on the form.
- `create: { form: … }`, `presentation:` on a form and `kind: Ui.PageSurface` are each refused by `telo check` and at load.
- The showcase, the chat example and `CrudUi.Admin`'s tests pass with every opener rewritten as a page.

## Bookkeeping

Docs: `ui` `surfaces.md` (surfaces of opened pages, placement against what opened them, `Ui.PageSurface` gone), `listing.md`, `form.md`, `presses.md`; `ui-react` `urls.md` (the open key); `crud-ui` `admin.md`. The form's controller takes the `UI_WRITE_*` twins from the listing's. Every in-repo manifest using an opener. The Declarative UI and CRUD paragraphs of `modules/CLAUDE.md`, the primer and the hub `build-ui` guide, which state that a record's screens are pages. The ledger's "How a form opens is declared, not built" entry rewritten around pages. `Added` fragments describing the break for `ui`, `ui-react`, `ui-react-radix` and `crud-ui`. `telo release floor` with the change.
