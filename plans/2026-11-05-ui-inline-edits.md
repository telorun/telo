---
status: draft
priority: medium
depends-on: [2026-11-15-collection-partial-writes.md, 2026-11-05-ui-press-and-record-detail.md]
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/ui-react-conformance, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
refinement: not-started
---

# Editing a value where it is shown

## Problem

Changing one value of a record means opening its edit form. Marking a task done, moving a status, rating an item or reassigning a row is: press the row's edit button, find the field, change it, submit, close. A listing can show a boolean as text but not as a switch the viewer flips.

Home Assistant's tile card takes `features:` — a toggle, a slider, a select — that act on the entity in place, and every data grid marks a column editable. A Telo listing should offer the same, with what a control may edit still judged before the app runs.

## Constraints

None.

## Surface

**Added**

- `field` — key on a `Ui.TableLayout` column: a property name or a `Ui.Field` kind; the cell is drawn as that field's control.
- `fields` — key on `Ui.ListLayout`, `Ui.CardLayout`, `Ui.BoardLayout`, `Ui.CalendarLayout`, `Ui.TimelineLayout` and `Ui.TreeLayout`: a list of property names and `Ui.Field` kinds, drawn in each record's actions region before its row actions.
- `UI_INLINE_FIELD_NOT_UPDATABLE` (twin `ERR_UI_INLINE_FIELD_NOT_UPDATABLE`) — an inline field whose property the collection's `schemas.update` does not declare, or a collection declaring none.
- `UI_COLUMN_FIELD_VALUE_MISMATCH` (twin `ERR_UI_COLUMN_FIELD_VALUE_MISMATCH`) — a column with `field` whose `value` is not exactly `row.<the field's property>`.
- `fields` — member of each record in the layout contract `ui_react_layouts-2`, and the host component `InlineEdit` exported by `@telorun/ui-react`.
- Styling part `inline-edit`, carrying `data-pending` and `data-invalid`.
- Keyed texts `inlineSaving` and `inlineFailed` in `Ui.Translations` and its fourteen translations.
- Wire: `field` on a table column spec and `fields` on each of the six layout specs, each entry a field spec; `[]` and absent when none is written.

**Changed**

- `UI_FIELD_DUPLICATE` — also reported for two inline fields of one layout entering one property.

**Removed**

- None.

## Solution

**Editability is declared where the control is drawn.** A table column says `field: done`, and its cell is a switch. A layout whose record is a free node tree has no column to mark, so it takes `fields: [done, status]`, drawn in the record's actions region — the place the row actions already occupy in every layout. An entry is a property name, which is exactly `{ kind: Ui.InputField, property: <name> }`, or any field kind: a select over an option source, a picker of related records. A relation property named bare is entered with a picker from the listing's presentation, as on a form. A field's `group` has no meaning in a row and is refused (`SCHEMA_VIOLATION`).

**Judged against what the collection accepts.** The listing's collection declares `schemas.update`. An inline field's property must be one it declares — the collection's key never is — or it is `UI_INLINE_FIELD_NOT_UPDATABLE`; each field kind judges its own fit against that shape, through the rules a form's fields already use, so a field kind of another module is checked with no change to `ui`. A column's `field` must enter the property its `value` shows (`UI_COLUMN_FIELD_VALUE_MISMATCH`); a column with `press` or `cell` takes no `field` (`SCHEMA_VIOLATION`).

**What it sends.** `PATCH <basePath>/<key value>` with a body of one member, `{ <property>: <value> }`, an emptied field as `null`. There is no read first, and nothing the list did not select can be cleared. It carries `If-Match` under the page-wide validator rule — when something on the page read that record's own address — and not otherwise: the list's rows carry no validator. The answer replaces the row, and `<basePath>` and `<basePath>/<key value>` are announced as after any write.

**When it sends.** A field drawn by a control reporting `onCommit` in the controls contract (`TextInput`, `NumberInput`, `Slider`) sends on commit — Enter or leaving a text field, release of a slider — with Escape reverting; one reporting only `onChange` (`Checkbox`, `Select`, `MultiSelect`, `Listbox`, the picker, the date range) sends on change. No control is added to the contract; each is drawn with its field's label as its accessible name and, in a table, without a visible label beside the column header.

**While pending** the control shows the entered value, busy and disabled. **On failure** it reverts: a 400 issue whose pointer names the property is drawn on the control, a `412` re-reads the listing and says the record changed, anything else is drawn as the row's failure, as a row action's is.

**Per row.** The field's `shown` condition is read over the row as `values`; where it does not hold, a table cell draws the value read-only and a layout's actions region leaves the field out.

**Component layouts.** A record of `ui_react_layouts-2` — the generation the press plan introduces — carries `fields`, and a component places `InlineEdit` where it draws a value, with the same commit, pending and failure behaviour. A layout vector pins that behaviour for any component using it.

**Controls and themes.** Inline controls carry the `inline-edit` part; `UiReactConformance.CheckTheme` gains a scene drawing each inline control, so every theme is held to them.

**Before / after.** Before, flipping a task's `done` is four presses through a form, and the save reads the record and replaces it. After, `field: done` on the column draws a switch in every row, and flipping one sends `PATCH /api/tasks/7` with `{ "done": true }`.

## Example

```yaml
kind: Ui.Listing
metadata: { name: tasks }
presentation: !ref tasksPresentation
model: !ref Task
layout:
  kind: Ui.TableLayout
  columns:
    - { value: !cel "row.text" }
    - value: !cel "row.status"
      field: { kind: Ui.InputField, property: status, control: select }
    - { value: !cel "row.done", field: done }
compact:
  kind: Ui.CardLayout
  content: { type: value, value: !cel "row.text" }
  fields: [done]
```

## Decisions

- **Marked at the place, not listed elsewhere and matched by expression.** A list of property names apart from the layout needs the layout searched for a cell showing each, and a warning when none does; the column is the only thing that knows where the control is drawn.
- **A layout-level list for node-tree layouts, not a key on the `value` node.** A `value` node is drawn in trees no listing owns — a reader's, an action's answer — where an edit would have no collection to write to and nothing to judge it.
- **The field is declared here, not borrowed from an edit form.** A record's edit screen is a page of its own; a cell depending on a form elsewhere would break when that page changes.
- **A one-member `PATCH`.** The row is the list shape, narrower than the record; anything that sends more than the edited property either reads first or clears what the list did not select.
- **No optimistic success.** The control shows the entered value while pending but never as saved; a refusal reverts, so the screen never shows a value the server did not accept.
- **Disabled while pending**, not queued: a queued change would be sent over a row the first change's answer has already replaced.
- **A write that is not a property's value stays an action.** A status transition with its own route is a row action or a board's `move`.

## Verify

- A task table with `field: done` draws `done` as a switch; flipping it sends exactly `PATCH /api/tasks/7` with `{ "done": true }` and no `GET`, and every listing over `/api/tasks` reads again.
- A list shape that omits `notes`: after a flip the record still holds its `notes`.
- `fields: [done]` on a card layout draws the switch among each card's actions, before its row actions.
- A 400 with `data.issues` at `/body/done` reverts the switch and shows the message on it; a 500 reverts and shows the row failure; a `412` reverts and the listing reads again.
- A slider sends once on release, not while dragging; a text input sends on Enter, not per keystroke; Escape reverts without sending.
- A row whose `shown` condition fails draws the value as text.
- A property absent from `schemas.update`, the key included, is `UI_INLINE_FIELD_NOT_UPDATABLE`; a column showing `row.title` with `field: done` is `UI_COLUMN_FIELD_VALUE_MISMATCH`; two entries for one property are `UI_FIELD_DUPLICATE` — each refused at the declaring library and failing a consumer's run with the twin.
- A component layout placing `InlineEdit` passes the layout vector; `CheckTheme` passes for both built-in themes with the inline scene.

## Bookkeeping

Docs (`listing-layouts.md`, `field-kinds.md`, `listing.md`; `ui-react` `layouts-abi.md`, `component-abi.md`, `styling.md`); the part list; default-theme, `ui-react-radix` and showcase `brand.css` styles; the keyed texts in all fourteen catalogs; a showcase table and board with inline fields and tests under its `tests/`; the hub `build-ui` guide (within its 32768-byte bound), the primer, `modules/CLAUDE.md`; a ledger entry under Standard library, "Edit a value where it is shown"; `Added` fragments for `ui`, `ui-react`, `ui-react-radix`, `ui-react-conformance`; changesets for `@telorun/ui-react-contract` and `@telorun/ui-react` where their published code moves. `telo release floor` with the change.
