---
status: draft
priority: high
depends-on: []
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/crud-ui, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
---

# Pressing anything, and records that open the same everywhere

## Problem

Only three things in a screen react to a press: a `link` navigates, a `Ui.Action` composite draws its own button, and `rowActions` put buttons on rows of a listing or a `list` node. Everything else is inert:

- A card in `Ui.CardLayout`, a table row, a board card, a calendar event, a `badge`, an `image`, a `value` cannot do anything when pressed. Making a card open something means putting a `link` inside it.
- No surface opens except a listing's `create` / `edit` (and the picker, filter overlay, split view and tab bar, each for its own content). There is no way to show more about a record in a dialog or drawer.
- There is no view of one record. A relation's label in a column links only where its `href` is written, to a page the author builds by hand from `Ui.Data` over `query.id`, and every place showing that record repeats the link.

Home Assistant gives every card one interaction vocabulary (navigate, open the entity's standard dialog, run an operation, nothing) and opens every entity, wherever it appears, in the same "more-info" dialog. This plan brings both.

## Solution

**One press vocabulary.** `press` is a reference slot (`x-telo-ref`, kind `Ui.Press`) holding an inline declaration of one of four kinds under the `Ui.Press` abstract — so each press is a resource the analyzer checks with resource and referrer rules wherever it is written, inside a node tree included, exactly as an inline composite is:

- `Ui.Navigate` — `{ href, label? }`, `href` a `Ui.Address`. Drawn as a real `<a>`, so it opens in a new tab like any link.
- `Ui.Run` — `{ action, inputs, confirm?, prompt?, enabled?, label?, answer? }`: the `Ui.RowAction` members, plus `answer`, a reference to the `Ui.Overlay` its `result` / `failure` tree is drawn in — a `Ui.Popover` anchored to the pressed element by default, filled by `ui`. A failure is always drawn; a success draws nothing when the action's `onSuccess.navigate` moves the page.
- `Ui.OpenView` — `{ content, surface?, title?, label? }`: a node tree drawn in a `Ui.Overlay` (a `Ui.Dialog` by default), over the roots in scope where it is pressed.
- `Ui.OpenRecord` — `{ presentation, key, label? }`: opens that record's detail (below); `presentation` a reference slot, `key` an accessor expanded into the item path as an address's `pathParams` value is.

The press's own regions (`Ui.Run.inputs`, `Ui.OpenView.content`, `Ui.OpenRecord.key`) read the roots in scope where the press is written — `row`, `data`, `query`, `values`, `result`, `input` — each typed from the referrer's binding of that name (`x-telo-context-from-referrer`), the mechanism a field's `values` already uses. A root absent at the press site is `CEL_UNKNOWN_IDENTIFIER`.

`press` is accepted by the `box`, `stack`, `columns`, `text`, `badge`, `image`, `svg` and `value` nodes, by `Ui.Listing` (what pressing a record does), and replaces `href` on a `Ui.CollectionPresentation` relation (what pressing a related record's label does). `link`, `menu` and `tabs` stay as they are, since each already is a press. `label` is the accessible name; omitted, the pressed element's own text is.

A pressed container uses the covering-target pattern: one real button or link spans the container and every interactive element inside it (a link, a row action, an inline control) sits above it and stays separately reachable by keyboard and screen reader. Nesting presses is therefore legal and needs no rule. A covering `Ui.Navigate` to the current address marks its record selected, as any link to the current address does.

On the wire every pressable `Ui.SpecNode` branch carries `press` (null when absent), a `Ui.PressSpec` whose `type` tag — `navigate`, `run`, `openView`, `openRecord` — is one-to-one with the kind. The four kinds are the roster: a kind of another module may specialize one (`extends` with `base:`), but a new way of pressing is a new `Ui.PressSpec` branch every renderer draws, so the abstract admits no other direct descendant (`UI_PRESS_KIND_UNSUPPORTED`).

**A record's detail is declared once, on its presentation.** `Ui.CollectionPresentation` gains `detail: { title?, content?, surface?, actions?, edit?, delete?, loading?, failure? }`:

- It reads `GET <basePath>/<key>`, the item route the collection contract already requires, and draws `content` over the `data` root typed from the collection's `model`, as a `Ui.Data` reader would. Omitted `content` is one `value` per model property except the key, as a card's is. `title` is a `Ui.BoundText` over `data`, the record's key by default. `loading` and `failure` are node trees `ui` fills when omitted, as for `Ui.Data`; a 404 draws `failure`.
- `surface` is a reference to a `Ui.Overlay` or `Ui.PageSurface`, a `Ui.Drawer` at the end edge by default. With `address: { name }` the open record is in the page address as `_telo.open.<name>=<key>`, so a link reaches it and a reload reopens it; an empty value opens nothing, since a detail has no "new". Without `address` the open record lives in memory. An address name is one open surface per page, as it is for openers today.
- `actions` is a list of `Ui.RowAction` over `data` in the detail's footer; `edit` is an opener of the listing's `edit` shape (`{ form, surface?, afterSubmit?, unsaved? }`); `delete: true` adds the listing's confirmed delete. A write from the detail announces the record's path and `basePath`, so the detail and every listing over the collection read again; a deleted record closes its detail.

What opens a detail: `Ui.OpenRecord` wherever it is written; and **a listing whose presentation declares `detail` and whose `press` is omitted opens the pressed record's detail** — the default that makes every record in every built-in layout open the same way. A relation opens the related record's detail with `press: { kind: Ui.OpenRecord, presentation: !ref authorsPresentation, key: !cel "row.id" }`.

**Layouts.** Every built-in layout draws the record press on the whole record (table row, list item, card, board card, calendar and timeline event, tree item). The layout ABI `ui_react_layouts-1` gains, additively, `can.press` and the `onPress(key)` intent; `onOpen` keeps its meaning (the `edit` opener). A component layout draws its own records, so one that never calls `onPress` has no record press; one built before the change runs unchanged.

**Rules**, each declared on the kind, pinned both ways in `modules/ui/tests/` (refused at the declaring library, `runFails:` from a consumer) and twinned by its controller:

- `Ui.Run.inputs` judged as a call-site argument map against the action's `inputModel` with the analyzer's own codes (`CONTRACT_INPUTS_MISMATCH`, `CEL_UNKNOWN_FIELD`, `CEL_TYPE_ERROR`, `ACCESSOR_NOT_PLAIN_CHAIN`), twin `ERR_UI_RUN_INPUTS_INVALID`.
- `UI_PRESS_VIEW_ADDRESSED` — a resource rule on `Ui.OpenView` resolving its `surface`: an addressed surface (a cold load has no row or data to draw the tree over; a linkable view is a record detail). Twin `ERR_UI_PRESS_VIEW_ADDRESSED`.
- `UI_PRESS_DETAIL_UNDECLARED` — a resource rule on `Ui.OpenRecord` resolving `presentation`: one with no `detail`. Twin `ERR_UI_PRESS_DETAIL_UNDECLARED`.
- `UI_PRESS_KIND_UNSUPPORTED` — a referrer rule on `Ui.Press` for a direct descendant outside the roster. Twin `ERR_UI_PRESS_KIND_UNSUPPORTED`.

**Before / after.** Before, a card opening a record is a `link` inside the card content pointing at a hand-built page, repeated in every listing showing that collection. After, the presentation declares `detail` once and every listing over it opens the record in the same drawer, addressed and linkable, with the related-record labels opening theirs.

## Decisions

- **Press only; no hold or double-tap.** Both are touch idioms with no keyboard or screen-reader equivalent and nothing to discover them by. One press, plus the row actions and menus that already exist, covers what Home Assistant's three gestures are used for.
- **A press is an inline resource at a reference slot**, not a plain value: that is what lets its rules and typed regions reach a press inside a node tree, where a rule over plain node data cannot. Its variants are kinds, the rule for every slot value; `type` tags stay for nodes and the wire.
- **`press` replaces a relation's `href`** rather than living beside it: one way to say what pressing a related label does. No manifest migration: matching the `Ui.` prefix and every hosting kind in a data migration is the obstacle the composable chat plan declined; `href` becomes `SCHEMA_VIOLATION`, in-repo manifests are updated, and the `ui` fragment describes the break. `crud-ui` forwards `relations` whole, so `CrudUi.Admin` takes `press` with no change of its own; an importer pinned to an older `ui` is unaffected.
- **The covering target, not a nesting refusal.** Refusing nesting would forbid the common card holding its own links; the covering-target pattern is the accessible form of a pressable card.
- **Detail lives on the presentation**, not the source: how a record is shown is presentation, and two presentations of one collection may show it differently. `Ui.CollectionSource` stays the transport.
- **A detail reads by key, always.** It never draws from the row it was opened from, so it is the same whether opened from a listing, a relation, a link or a cold load, and its `data` is typed from `model` rather than from whatever shape a listing read.
- **No static key-type check.** The key is a path segment expanded like any `pathParams` value, which carries no type match either; a key that does not name a record draws the detail's `failure`.
- **`Ui.OpenView` cannot be addressed**, `Ui.OpenRecord` can: a record has a key to reload by, an arbitrary tree over a row does not.
- **A closed press roster.** Every renderer must draw every press; an open abstract would let a module add a press no renderer knows.

Bookkeeping: docs (`nodes.md`, new `press.md`, `collection-presentation.md` with the detail, `listing.md`, `listing-layouts.md`, `surfaces.md`, `ui-react` `layouts-abi.md` and `styling.md` with the `press` and `detail` parts); new keyed texts (`detailClose`, `detailEdit`) in all fourteen catalogs; the part list and its default-theme, `ui-react-radix` and showcase `brand.css` styles; `crud-ui` docs showing `press` in `relations`; the hub `build-ui` guide (within its 32768-byte bound), the primer, `modules/CLAUDE.md`'s Declarative UI paragraph; a ledger entry under Standard library, "Records that open the same everywhere"; `Added` fragments for `ui` (describing the `href` break), `ui-react`, `ui-react-radix`, `crud-ui`; a changeset for `@telorun/ui-react-contract`. `requires:` floors where the previous published CLI, run against a module's own file with the block stripped, rejects it — the showcase and every in-repo module adopting `press`.

## Verify

- A `Ui.CardLayout` listing over posts whose presentation declares `detail` opens the pressed post in an end drawer; the address gains `_telo.open.post=<id>`; reloading reopens it; Escape closes it and drops the parameter; a deleted post's detail draws `failure` on reload.
- The same post pressed in a table, a board and a calendar opens the same drawer; a card holding a `link` follows the link, not the card press, by mouse and by keyboard.
- An author label in a post row with `press: { kind: Ui.OpenRecord, … }` opens the author's detail.
- A `badge` with `press: { kind: Ui.Run, … }` inside a `Ui.Data` content binds `data` in its `inputs`, sends its request, shows the answer in a popover anchored to the badge, and announces as an action does; `inputs: { id: !cel "row.id" }` there is `CEL_UNKNOWN_IDENTIFIER`.
- `UI_PRESS_VIEW_ADDRESSED`, `UI_PRESS_DETAIL_UNDECLARED` and `UI_PRESS_KIND_UNSUPPORTED`, each written on a press inside a node tree, are refused at the declaring library and fail a consumer's run with the twin; `href` on a relation is `SCHEMA_VIOLATION`.
- A component layout built against `ui_react_layouts-1` before the change runs unchanged; one calling `onPress` opens the detail.
- `CheckTheme` passes for both built-in themes and the showcase brand theme with the new parts.

## Example after the change

```yaml
kind: Ui.CollectionPresentation
metadata: { name: postsPresentation }
source: !ref postsSource
relations:
  authorId:
    source: !ref authorsSource
    label: !cel "row.name"
    press: { kind: Ui.OpenRecord, presentation: !ref authorsPresentation, key: !cel "row.id" }
detail:
  title: { text: "{$title}", values: { title: !cel "data.title" } }
  surface: { kind: Ui.Drawer, side: end, address: { name: post } }
  edit: { form: { kind: Ui.Form, model: !ref NewPost, presentation: !ref postsPresentation } }
  delete: true
  actions:
    - { action: !ref publish, inputs: { id: !cel "data.id" }, confirm: Publish this post? }
---
kind: Ui.Listing
metadata: { name: postCards }
presentation: !ref postsPresentation
model: !ref Post
layout: { kind: Ui.CardLayout, size: small }
```
