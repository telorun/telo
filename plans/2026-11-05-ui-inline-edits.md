---
status: draft
priority: medium
depends-on: []
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/ui-react-conformance, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
---

# Editing a value where it is shown

## Problem

Changing one value of a record means opening its edit form. Marking a task done, moving a status, rating an item or reassigning a row is: press the row's edit button, find the field, change it, submit, close. A listing can show a boolean as text but not as a switch the viewer flips. The nearest thing is an edit opener on `Ui.InlineSurface`, which still draws the whole form under the record.

Home Assistant's tile card takes `features:` — a toggle, a slider, a select — that act on the entity in place. A Telo listing should offer the same, with what a control may edit still judged before the app runs.

## Solution

**`inline` on a listing's edit opener.** `Ui.Listing.edit` gains `inline`: a list of property names, each one the edit form offers as a field (the form's `fields`, or every enterable property when it lists none). Each is edited in place with **that form field** — its kind, control, option source, label and `shown` — so the inline control and the form can never disagree about how a property is entered. `inline` exists only inside `edit`, so an inline edit without an edit form cannot be written.

**Where it is drawn.** In every built-in layout, wherever the record presents the property through exactly `row.<property>`: a `Ui.TableLayout` column whose `value` is that chain, a `value` node in a layout's `content` (cards, list, board, calendar, timeline, tree) and the default per-property values; in the listing's `compact` layout by the same rule. A column with `href` or `cell` is never inline — it is a link or a component — and neither is a `value` node with `href`. A relation property is edited with the form's field for it, a picker by default. A field's `group` has no meaning in a row and is ignored.

**What it sends.** Exactly what the edit form sends: the record is read by key (`GET <basePath>/<key>`, which may hold more than the listing's row), the new value is put over it, and the result is sent as `PUT <basePath>/<key>`, validated against the form's `model`. A property the list shape does not select is therefore never cleared. The answer replaces the row until the announced reload of `basePath` (and `<basePath>/<key>`, as an edit announces) reads the list shape again.

**Stated limit.** Between that read and the `PUT`, another viewer's change to the same record is overwritten — the edit form's window, one round trip long. Closing it needs a conditional or partial write in the collection contract, which this plan does not change.

**When it sends.** A field drawn by a control reporting `onCommit` in `ui_react_controls-3` (`TextInput`, `NumberInput`, `Slider`) sends on commit — Enter or leaving a text field, release of a slider — with Escape reverting; one reporting only `onChange` (`Checkbox`, `Select`, `MultiSelect`, `Listbox`, the picker, the date range) sends on change. No control is added to the contract; each is drawn with its field's label as its accessible name and without a visible label beside a column header.

**While pending** the control shows the entered value, busy and disabled. **On failure** it reverts: a 400 issue whose pointer names the property is drawn on the control, anything else as the row's failure, as a row action's is.

**Per row.** The field's `shown` condition is read over the row as the form's `values` (the form model's properties the row holds; one the row does not hold is missing, and a missing value never satisfies a condition). Where it does not hold, the value is drawn read-only.

**Component layouts.** The layout ABI `ui_react_layouts-1` gains, additively, an `inline` member on each record (its editable properties) and a host component, `InlineEdit`, exported by `@telorun/ui-react`, that a component places where it draws a value, with the same read, commit, pending and failure behaviour. A layout vector pins that behaviour for any component using it.

**Rules**, each pinned both ways in `modules/ui/tests/` and twinned in the listing's controller:

- `UI_INLINE_FIELD_NOT_IN_FORM` — an `inline` property the edit form does not offer as a field (twin `ERR_UI_INLINE_FIELD_NOT_IN_FORM`).
- `UI_INLINE_FIELD_KEY` — the collection's key property (twin `ERR_UI_INLINE_FIELD_KEY`).
- `UI_INLINE_FIELD_DUPLICATE` — a property listed twice (twin `ERR_UI_INLINE_FIELD_DUPLICATE`).
- `UI_INLINE_FIELD_UNPLACED` — a warning, a referrer rule on `Ui.TableLayout` from `Ui.Listing`: an `inline` property no column presents as `row.<property>` (no twin; it refuses nothing). A layout whose content is a node tree cannot be judged this way, which the docs state.

The field's own fit (`UI_FIELD_CONTROL_UNSUPPORTED`, `UI_FIELD_UNSUPPORTED`) is already judged on the form, so an inline field needs no second fit rule.

**Controls and themes.** Inline controls carry the `inline-edit` part (with `data-pending` and `data-invalid`); `UiReactConformance.CheckTheme` gains a scene drawing each inline control, so every theme is held to them.

**Before / after.** Before, flipping a task's `done` is four presses through a form. After, `edit: { form: …, inline: [done, status] }` draws `done` as a switch and `status` as a select in every row, and flipping one saves it.

## Decisions

- **Inline edits ride the edit opener and reuse its fields**, not a new request vocabulary or a second field declaration. The edit form already owns the write shape, the record contract's `PUT`, which properties may be written and how each is entered; listing a property name is all an inline edit adds. A write that is not a record replace (a status transition with its own route) stays a row action or a board's `move`.
- **Read, overlay, replace.** The listing's row is the list shape, narrower than the record; replacing from it would clear every property the list does not select.
- **Placement by `row.<property>`, not a new column key.** A column or `value` already says which property it shows; any other expression is not one property's value and cannot be written back.
- **No optimistic success.** The control shows the entered value while pending but never as saved; a refusal reverts, so the screen never shows a value the server did not accept.
- **Disabled while pending**, not queued: a queued change would be sent over a row the first change's answer has already replaced.

Bookkeeping: docs (`listing.md`, `field-kinds.md`, `listing-layouts.md`, `ui-react` `layouts-abi.md`, `component-abi.md`, `styling.md`); the part list; default-theme, `ui-react-radix` and showcase `brand.css` styles; keyed texts (`inlineSaving`, `inlineFailed`) in all fourteen catalogs; a showcase table and board with inline fields and tests under its `tests/`; the hub `build-ui` guide (within its 32768-byte bound), the primer, `modules/CLAUDE.md`; a ledger entry under Standard library, "Edit a value where it is shown"; `Added` fragments for `ui`, `ui-react`, `ui-react-radix`, `ui-react-conformance`; changesets for `@telorun/ui-react-contract` and `@telorun/ui-react` where their published code moves. `requires:` floors where the previous published CLI, run against a module's own file with the block stripped, rejects it.

## Verify

- A task table with `inline: [done]` draws `done` as a switch; flipping it reads `GET /api/tasks/7`, sends `PUT /api/tasks/7` with that record and `done: true`, and every listing over `/api/tasks` reads again.
- A list shape that omits `notes`: after a flip the record still holds its `notes`.
- A 400 with `data.issues` at `/body/done` reverts the switch and shows the message on it; a 500 reverts and shows the row failure.
- A slider sends once on release, not while dragging; a text input sends on Enter, not per keystroke; Escape reverts without sending.
- A row whose `shown` condition fails draws the value as text; a column with `href` on `done` draws a link, not a switch.
- A property the form does not offer is `UI_INLINE_FIELD_NOT_IN_FORM`, the key `UI_INLINE_FIELD_KEY`, a repeat `UI_INLINE_FIELD_DUPLICATE` — each refused at the declaring library and failing a consumer's run with the twin; a table with no column for an inline property warns `UI_INLINE_FIELD_UNPLACED`.
- A component layout placing `InlineEdit` passes the layout vector; `CheckTheme` passes for both built-in themes with the inline scene.

## Example after the change

```yaml
kind: Ui.Listing
metadata: { name: tasks }
presentation: !ref tasksPresentation
model: !ref Task
edit:
  form:
    kind: Ui.Form
    model: !ref NewTask
    presentation: !ref tasksPresentation
    fields: [text, done, { kind: Ui.InputField, property: status, control: select }]
  inline: [done, status]
layout:
  kind: Ui.TableLayout
  columns:
    - { value: !cel "row.text" }
    - { value: !cel "row.status" }
    - { value: !cel "row.done" }
```
