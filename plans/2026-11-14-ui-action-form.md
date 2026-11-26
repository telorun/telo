---
status: done
priority: medium
depends-on: [2026-11-15-ui-record-pages.md]
packages: [modules/ui, modules/ui-react, modules/crud-ui, modules/data-model, analyzer, examples/ui-showcase, examples/chat, examples/report-console, apps/hub, apps/authoring-agent, docs]
refinement: ready
---

# Mutations, and forms whose values drive queries and save as they are edited

## Problem

Three things cannot be built, and one kind is in the way of all of them.

- **A live preview** (issue #822). A page's main element is a period and a few display options, sent to a read route, with the matching records listed under it and a row button running the real operation from those values. Today the page is a `Ui.Action` and the person presses Show after every change, though the route has no side effects. The only screen whose reads follow entered values is a `Ui.Filters` bar, which drives listings over a collection.
- **Autosave of a draft before publishing.** An editor loses its edits unless Save is pressed, and nothing says "saving".
- **A write run from anywhere but its own form.** `Ui.Action` is a write welded to a form, a button and the trees drawn over its answer. A row action, a `button` node, a markdown annotation and a notification's Undo all run one through `Ui.BoundAction` and ignore its form and button — yet the action must still list a field for every required input, and its `onSuccess.to` applies wherever it runs.

`Ui.Form` cannot take the action's place: `record` is required and its submit is a write to that collection, so a form that is not a record editor cannot exist. And making `Ui.Action`'s button press itself is the wrong model twice over: a preview is a read, which should follow its inputs the way every query follows its address, and whether a write needs a press is a property of where it is run, not of the operation.

## Constraints

None.

## Surface

**Added**

- `Ui.Mutation` — a declared write: `inputModel`, `outputModel?`, `method?`, `url`, `invalidates?`, `concurrency?`. It draws nothing.
- `Ui.Effect` — abstract over what happens after a write succeeds; `Ui.Destination` extends it.
- `Ui.MutationCall` — named shape `{ mutation, inputs, label, confirm?, prompt?, enabled?, onSuccess?, result?, failure? }`: a pressed run of a mutation, `inputs` bound from the roots in scope (`{}` for a mutation that takes nothing), and what is drawn from its answer where it ran.
- `Ui.Move` — named shape `{ mutation, inputs, confirm?, prompt?, enabled?, onSuccess?, failure? }`: a layout's `move`; no `label` and no `result`.
- `Ui.Prompt` — `{ model, fields?, groups? }`: the dialog a call opens to ask for entries before it runs.
- The `prompt` root — at a call's `inputs`, what was entered in its prompt, typed from the prompt's `model`.
- `Ui.Form.onSubmit` — `{ mutation, inputs, label?, confirm?, enabled?, result?, failure? }`: run when the form is submitted; `label` defaults to `ui`'s `save` text.
- `Ui.Form.autosave` — `{ mutation, inputs, debounce?, result?, failure? }`: run when the values settle; `debounce` a `Telo.Duration` of at least `0s`, default `300ms`.
- `Ui.Form.onSuccess` — a list of effects run after the form's submit write succeeds, its default write or `onSubmit`'s, over `values` and `result`.
- `Ui.Form.clearAnswerOn` — form properties whose change clears what its writes drew from their last answers.
- `UI_FORM_CLEAR_UNKNOWN_PROPERTY` (twin `ERR_UI_FORM_CLEAR_UNKNOWN_PROPERTY`) — `clearAnswerOn` naming a property the form's `model` does not declare.
- `CONTEXT_REF_FROM_INVALID` — a kind's `x-telo-context-ref-from` path whose segments up to and including the first reference slot the schema of the object holding the region does not declare, or that crosses no slot; analyzer-only, reported at the kind.
- `UI_FORM_AUTOSAVE_NOT_IDEMPOTENT` (twin `ERR_UI_FORM_AUTOSAVE_NOT_IDEMPOTENT`) — `autosave` over a mutation whose `method` is `POST`, written or by default.
- `Ui.Query.form` — a reference to the `Ui.Form` whose values the query reads; binds the `form` root in its `url` and `input.body`, and in the trees of every `query` node drawing it.
- `Ui.Listing.form` — the same for a listing: binds `form` in its `filters` and its row actions.
- The `form` root — a browser root where a query or listing names a form: the form's settled, valid record, typed from its `model`.
- Wire: a `Ui.MutationSpec` `{ id, schema, answer?, method, url, consumed, invalidates, concurrency }`; a call spec per shape, `onSuccess` a list of effect specs (`[]` when none), and `prompt` a prompt spec or `null`, wherever a bound action was; the `form` node's `id`, `onSubmit`, `autosave` (`debounce` in integer milliseconds), `onSuccess` and `clearAnswerOn`; `form` on the query spec and the `listing` node (the form's id, `null` when none).
- Keyed texts `saving` and `retry` in `Ui.Translations` and its fourteen translations.
- Parts `mutation-result` and `mutation-failure` (a call's answer trees wherever it runs), `saving` and `retry`.
- `aria-busy` on a form's answer region while an `autosave` write is awaited.
- `modules/ui/conformance/form-writes.json` — the renderer-neutral vectors `ui-react` runs.

**Changed**

- Every place that ran an action holds a call: a listing's and a `list` node's `rowActions`, a markdown node's `annotations.action` and the `button` node, which holds its call under `action`, a `Ui.MutationCall`, a layout's `move` a `Ui.Move`. `action:` becomes `mutation:`, and the call carries its own `label`, `result` and `failure`.
- `onSuccess` — moves from the write to the call and becomes a list of effects, `[<Ui.Effect>…]`; `onSuccess.to` is gone (`SCHEMA_VIOLATION`).
- `Ui.Destination` — extends `Ui.Effect`, so `Ui.Navigate` and `Ui.OpenPage` are effects.
- `prompt` — was `true`, asking with the action's own fields; now a `Ui.Prompt`, inline or by `!ref`, whose entries `inputs` binds through the `prompt` root. `prompt: true` is `SCHEMA_VIOLATION`.
- `UI_FIELD_REQUIRED_NOT_ENTERED`, `UI_FIELD_UNSUPPORTED` — judged on `Ui.Prompt` as on `Ui.Form`, no longer on an action.
- `x-telo-context-withheld` — also legal beside `x-telo-context-ref-from`, with the JSON Schema keywords of the node's own reading beside it: the binding is typed where the path names something and withheld where no alternative names anything.
- `x-telo-context-ref-from` — a path read from the object holding the region, data segments to its first reference slot and then across each slot; also a list of paths, read as ordered alternatives: the first that names something types the node. A path names nothing where a segment before its last crossed slot holds nothing, and names something where every segment through that slot holds a value — a crossing the walk cannot follow included, which leaves the node open. Where the path holds nothing, the node keeps its own keywords before an open schema.
- `Ui.Chat.refreshes` → `invalidates`, `Ui.RefreshTarget` → `Ui.InvalidationTarget`, `modules/ui/conformance/refreshes.json` → `invalidations.json`.
- `Ui.Form` — `record` excludes `onSubmit` and `autosave`, and `onSuccess` and `afterSubmit` need `record` or `onSubmit` (each `SCHEMA_VIOLATION`).
- The collection contract — `POST <basePath>` answers 2xx with the stored record, valid against the collection's `model`, as `PATCH` does.
- `Ui.Form.record` — becomes optional. Without it the form has no collection: no relation pickers and no default write.
- `Ui.Form` binds `values`, `params` and `query` at `onSubmit.inputs` and `autosave.inputs`, typed from where the form is placed.
- The form's `data-state` value `submitting` also covers an `autosave` request in flight or held.
- A form is unsaved, for its `unsaved` guard, also while an `autosave` write is waiting, in flight or failed.
- The settle rule for entered values (a choice or a commit at once, typed text after a pause) is stated once in the controls contract and cited by `filters.md` and `form.md`.
- `UI_ACTION_INPUT_UNSENT` → `UI_MUTATION_INPUT_UNSENT`, `ERR_UI_BOUND_ACTION_INPUTS_INVALID` → `ERR_UI_MUTATION_CALL_INPUTS_INVALID`; the action contract is the mutation contract, unchanged in what it requires of a route.

**Removed**

- `Ui.Action` — an unknown kind (`UNDEFINED_KIND`); its wire `action` node with it. A form and a button that run one write are a `Ui.Form` with `onSubmit`; a bare button is a `button` node holding its call under `action`.
- `Ui.BoundAction` — `Ui.MutationCall` and `Ui.Move` replace it.
- `UI_ACTION_CLEAR_UNKNOWN_PROPERTY` — `UI_FORM_CLEAR_UNKNOWN_PROPERTY` replaces it.
- Parts `action`, `action-result`, `action-failure`, `row-answer`, `row-failure`, and `action` among `data-state`'s holders — `mutation-result` / `mutation-failure` replace the answer parts.

## Solution

**A mutation is the write, as a query is the read.** `Ui.Mutation` holds everything about the request and nothing about drawing: `inputModel` (the record it takes), `outputModel` (the shape of a success's body), `method` and `url` under the mutation contract (`method` `POST` by default, `PUT`, `PATCH` or `DELETE`, `GET` and `QUERY` refused; `url` a `Ui.RequestTarget` over `input`, consuming input properties exactly as `Ui.Action`'s `request.target` did, the body being the input minus what `url` consumes), `invalidates` (the request targets announced after a success, each a `Ui.InvalidationTarget` with the `*` / `**` wildcards), and `concurrency` (`parallel` or `serial`, across every call of the mutation on the page). It has no fields, no button and no answer trees, so it is the same write wherever it runs. This is the pair TanStack Query, Apollo and RTK Query declare: a query to read, a mutation to write, and the components that run them apart from both.

**A call runs one, where it is — one closed shape per holder.** Every trigger holds `mutation` (a `!ref` or one inline), `inputs` (bound from the roots in scope, judged against `inputModel` as today) and the trees drawn from its answer: `result` over `result` and `input`, `failure` over `error` and `input` (`ui` filling the failure). What else a holder takes depends on what it is, and each holder's shape lists exactly that, so a key that means nothing there is `SCHEMA_VIOLATION` with no rule:

- `Ui.MutationCall` — the `button` node, `rowActions` and `annotations.action`: `label` required (the button's accessible name), `confirm`, `prompt`, `enabled`, `onSuccess`.
- `Ui.Move` — a layout's `move`, a gesture with no button: `confirm`, `prompt` (a reason asked for on a drop), `enabled`, `onSuccess`; no `label` (the "Move to" menu names the target), no `result` (the success is the record in its new place), its `failure` drawn on the record.
- `onSubmit` — on `Ui.Form`: `label` optional, `confirm`, `enabled`; no `prompt`, since the form enters the fields, and no `onSuccess`, which is the form's.
- `autosave` — on `Ui.Form`: `debounce`; never pressed, so no `label`, `confirm`, `enabled` or `onSuccess`.

What follows a success depends on where the write was made, so it belongs to the holder: one mutation saves and stays from an autosave, saves and navigates from a submit, and saves silently from a row.

**After a success, a list of effects.** `onSuccess` is a list, each entry a `Ui.Effect` written inline: today a destination — `Ui.Navigate`, `Ui.OpenPage` — over `result` and `input`. The effects run in the order written, each after the one before has happened. They are resolved when the answer arrives and run by the page shell, not by the component that made the call, so they still run when that component's surface has closed. `Ui.Effect` is an abstract (`x-telo-ref`, kind `Ui.Effect`, at each entry), so an effect kind added later — another module's, or a notification — is accepted with no change to the call, and anything but an effect is `REFERENCE_KIND_MISMATCH`. `invalidates` stays on the mutation: which reads a write invalidates is the write's, wherever it ran.

**Prompting.** `prompt` holds a `Ui.Prompt`: `model` (what the person enters), `fields` and `groups` as a form's. Pressing the call opens a dialog with those fields, and `inputs` reads what was entered through the `prompt` root (`note: !cel "prompt.note"`), typed from the prompt's `model` and withheld where the call has no prompt. So every required input is bound in `inputs` — one left unbound is `CONTRACT_INPUTS_MISMATCH` — and the field rules (`UI_FIELD_REQUIRED_NOT_ENTERED`, `UI_FIELD_UNSUPPORTED`) are resource rules on `Ui.Prompt`, as on `Ui.Form`; the field kinds' referrer rules name `Ui.Form` and `Ui.Prompt`. A prompt is a kind of its own rather than a `Ui.Form`, because a form's `record`, `onSubmit`, `autosave`, `state` and `afterSubmit` mean nothing there, and rather than fields written on the call, because a call sits at any depth of a node tree where no rule can reach it.

**A form and a button that run one write** — what `Ui.Action` was — is a `Ui.Form` with `onSubmit`. Its `model` is what the person enters, `onSubmit.inputs` maps it onto the mutation's `inputModel`, its `enabled` reads `values`, and its answer is drawn beneath the fields. A bare button is `{ type: button, action: { mutation, inputs: {}, label } }`.

**`record` becomes optional.** Without it, `model` and `fields` are all the form needs: a bare property is entered with the control its type calls for, and a relation is entered by an explicit `Ui.PickerField`, which carries its own options (a bare relation property is `UI_FIELD_UNSUPPORTED`). A form with neither `record` nor `onSubmit` shows no submit button; with no `autosave` either it is legal, and its values are read by its own `shown` conditions, by forms sharing its `state.key`, and by every query or listing naming it in `form`.

**A form is one of three.** A record editor (`record`, its default write, `UI_WRITE_*` judged on it), a mutation form (`onSubmit` and/or `autosave`) or a free-standing form (neither). `record` beside `onSubmit` or `autosave` is `SCHEMA_VIOLATION`, and so are `onSuccess` and `afterSubmit` on a form with neither `record` nor `onSubmit`: beside a mutation, `record`'s key, baseline and validator would describe a write that is never made. A mutation form enters a relation through an explicit `Ui.PickerField` over `Ui.CollectionOptions`.

**What is shown follows the values, wherever it is placed.** A query names the form it reads, as an HTML `<input form="…">` or `<output for="…">` names a form placed elsewhere in the document: `Ui.Query.form: !ref previewForm`. That binds the `form` root in the query's `url` and `input.body` and in the `loading`, `content` and `failure` trees of every `query` node drawing it (typed through the node's slot, `x-telo-context-ref-from: "query/form/model"`), so `body: { period: !cel "form.period" }` sends the form's period and a row action inside the answer binds `form.columns` in its inputs. `Ui.Listing.form` does the same for a listing's `filters` and row actions. The query node and the form are placed independently — side by side, in another cell, under a tab, in a view of its own — so layout never follows data flow. `form` is the form's record once it has settled and is valid against its `model`:

- **Settling.** A choice or a control's commit (Enter, leaving the field, release) settles at once; typed text settles after the typing pause. This is the rule `apply: typing` on a filter bar already follows, stated once.
- **Validity.** While the entered record is invalid, `form` keeps the last valid record and the fields show their findings. Until the form first holds a valid record `form` holds nothing, and a query whose `url` or `input.body` reads it is not sent at all — as for a `url` that holds nothing, and unlike a body member whose chain over `query` or `params` holds nothing, which is only left out — and its nodes draw nothing, not even their `loading` tree, so an invalid start shows no loading indicator.
- **Reading.** A query reads again when the request its `url` and `input.body` resolve to changes — at most one read in flight, an answer to an earlier request never drawn, the drawn answer kept while the next is awaited.

**Typed from the form, checked by `telo check`.** `form` is a reference slot (`x-telo-ref`, `use: schema`, kind `Ui.Form`), and the root is typed by `x-telo-context-ref-from: "form/model"` beside `x-telo-context-withheld`, accessor-only like every browser root — so `form.perod` is `CEL_UNKNOWN_FIELD`, `form` read where the query names no form is `CEL_UNKNOWN_IDENTIFIER` ("'form' is not available here: the query names no form in `form`"), and a slot naming anything but a form is `REFERENCE_KIND_MISMATCH`. A query node's trees bind `form` from their own query only: a query node nested in another, whose query names no form, withholds it there. The two widenings that make this work are generic: `x-telo-context-withheld` becomes legal beside `x-telo-context-ref-from` (typed where the path names something, withheld where no alternative names anything — the rule it already follows beside `x-telo-context-from-referrer`), and `x-telo-context-ref-from` falls back to the node's own keywords where the path holds nothing, as `x-telo-context-from-root` already does. A path names nothing where a segment before its last crossed slot holds nothing — so a query node's `query/form/model` names nothing when its query names no form — and names something where every segment through that slot holds a value. The same pair types the `prompt` root and the `result` root of a form's `onSuccess`, the latter through the list form of `x-telo-context-ref-from` — ordered alternatives, the first that names something typing the node. No part of the analyzer names a form.

**Where the form is not drawn.** A query whose form is not on the page being drawn reads nothing and its nodes draw nothing, as for a `url` that holds nothing.

**One form, one record per page.** A form placed twice on one page is one record: both placements show and edit the same values, as two filter bars sharing a `state.key` share their state. The renderer keeps the settled record per form id and page — the page and each page opened over it keep their own — for as long as that page is drawn, and a query finds it by the id its spec carries. A form that starts again (its `initialValues` read at another address) discards its settled record, so `form` holds nothing until the form is valid again.

So the live preview is a form and a query node placed wherever the page wants them: the query reads once when the form first holds a valid record and again after every settled change, with no press, no debounce key and no rule about methods — the read is a `GET`, or a `QUERY` or `POST` when it sends a body.

**`onSubmit`.** Pressed, the record is judged against the called mutation's `inputModel`: invalid sends nothing and puts the findings on the fields until a field changes; valid flushes `autosave` writes, waits for them, and is not sent if one fails.

**After a submit.** When the submit write succeeds — a record editor's default write or `onSubmit`'s mutation — the write's `result` tree is drawn, then the form's `afterSubmit` applies (`close` | `keep` | `again`), then the form's `onSuccess` effects run in order. `onSuccess` reads `values` (typed from `model`) and `result` — after `onSubmit`, typed from its mutation's `outputModel` (closed and empty when it declares none); after the default write, the stored record the collection answered with, typed from the collection's `model` (`x-telo-context-ref-from: [onSubmit/mutation/outputModel, record/presentation/source/collection/model]`). So a create page goes to what it created with `pathParams: { id: !cel "result.id" }`. After `onSubmit` only the mutation's `invalidates` is announced; after the default write, the record's `<basePath>` and `<basePath>/<key value>`. One list on the form, rather than one on the form and one on `onSubmit`, because a form makes one submit write and two lists would leave one of them meaningless whenever the other is written.

**`autosave` — saving as it is edited.** `autosave` is for a write that replaces. It is sent when the bound record is valid against the called mutation's `inputModel`, differs from the baseline and is not the one already in flight. The baseline is the newest record the server acknowledged — the form's starting record at first — and a failure clears it, since the outcome is unknown. So nothing is sent at start, and after a failure any valid record, a reverted one included, is sent. A choice or a commit sends at once and typed text after `debounce`; the page becoming hidden sends a waiting write. A change made while a write is pending is held, the newest replacing older, and sent when the pending one answers: a write is never aborted and never reordered. Under a `serial` mutation the pending write also waits its turn in the mutation's page-wide queue behind other calls of it; the coalescing is the same under both values. Because changes are coalesced and a failed write is sent again, the mutation must replace — a `PUT`, or a `PATCH` sending the whole draft — which `form.md` states; a mutation whose `method` is `POST`, written or by default, is `UI_FORM_AUTOSAVE_NOT_IDEMPOTENT` — a resource rule on `Ui.Form` resolving `/autosave/mutation`, twinned by `ERR_UI_FORM_AUTOSAVE_NOT_IDEMPOTENT` at creation, which also covers a mutation reached through a library input. Creating a record belongs to a pressed call.

**What a write sends.** `inputs` is required and read like any call's: judged statically against the mutation's `inputModel`, so a binding it does not take is `CONTRACT_INPUTS_MISMATCH`. The roots in scope at `onSubmit.inputs` and `autosave.inputs` are `values`, `params` and `query`. There `values` is the record the form holds now, typed from `model`; `required` never changes a type, so `values.title` of an optional property is a string, and whether it is present is judged at run time against the `inputModel`. An input reading a property whose field is hidden or empty reads nothing and is left out of the record sent.

**Findings while editing.** For each write the record is judged against the called mutation's `inputModel` as values are entered, and an invalid one sends nothing and says why: a finding lands on the field a bound input names as exactly `values.<property>`, by the form's touched-field rule, and any other finding is drawn in that write's answer region. A field shows the form's `model` findings first, then each write's, identical wording once. A 400's issues land by the same rule.

**What is drawn.** Beneath the fields: `onSubmit`'s and `autosave`'s `result` and `failure` trees, over `result`, `input` (the record sent) and `values` (what the form holds now). While an `autosave` write is awaited the answer stays, `aria-busy` is set and `saving` is drawn beside it. The form's `data-state` is `idle`, `submitting` (in flight, or held behind one) or `error`. A failure replaces the write's answer with its `failure` tree plus a `retry` button and lasts until the next change or that button — nothing is retried automatically. A change to a property `clearAnswerOn` lists clears both writes' answers. A call's answers are drawn in the `mutation-result` and `mutation-failure` parts wherever it runs — beneath a form's fields, in a button's place, beside an annotation — told apart by their container; `saving` and `retry` are parts of their own.

**Unsaved, and leaving.** A form with `autosave` is unsaved while its record differs from its baseline — sendable or not — or a write is waiting or in flight, or the last write failed and none has been acknowledged since. Its `unsaved` key governs as for any form: `confirm` asks before a move that closes it, "keep editing" leaving the waiting write to send as scheduled and "discard" dropping it; an in-flight write is not aborted. Nothing is sent with `keepalive`, so a stuck server never blocks navigation. A form with no write is never unsaved.

**Autosave only replaces.** A pressed `POST` mutation creates the draft and the call's `onSuccess` goes to the editor's address built from `result.id`; the editor reads the draft with a `query` node, whose content places a `Ui.Form` with `initialValues` over `data`, a `PUT` `autosave` whose mutation's `inputModel` is loose, and an `onSubmit` Publish whose mutation's `inputModel` is strict. Each save announces its own target, `/api/posts/1`, which is the address the editor's query reads, so the query reads again after every save; the re-read keeps the form and what was typed since. A mutation call carries no `If-Match`, so with two tabs editing one draft the last write wins.

**No migration.** Splitting an action into a form, a call and a mutation is a structural move a data migration does not make; in-repo manifests are updated and the `ui` fragment describes the break.

## Example

The application is the fixture `modules/ui/tests/__fixtures__/form-events/telo.yaml`, serving both screens: the preview of issue #822 and a draft editor.

**Before** — the preview is a `POST` route behind a `Ui.Action` whose Show button the person presses after every change, and there is no draft editor:

```yaml
kind: Telo.Application
metadata: { name: FormEvents }
lang: en
imports:
  Http: ../../../../http-server
  Ui: ../../../
  UiReact: ../../../../ui-react
ports: { http: { env: PORT, protocol: tcp, default: 8160 } }
targets:
  - !ref server
---
kind: Telo.JsonSchema
metadata: { name: PreviewRequest }
schema:
  type: object
  additionalProperties: false
  required: [period, columns, showChart]
  properties:
    period:
      type: object
      additionalProperties: false
      required: [from, to]
      properties: { from: { type: string, format: date }, to: { type: string, format: date } }
    columns: { type: string, enum: [short, full], default: short }
    showChart: { type: boolean, default: false }
---
kind: Telo.JsonSchema
metadata: { name: PreviewAnswer }
schema:
  type: object
  required: [items]
  properties:
    items:
      type: array
      items:
        type: object
        required: [name, hours]
        properties: { name: { type: string }, hours: { type: number } }
---
kind: Http.Api
metadata: { name: api }
routes:
  - request: { method: POST, path: /preview }
    handler: { kind: Telo.Value, value: { items: [{ name: Ada, hours: 12 }, { name: Grace, hours: 9 }] } }
    returns:
      - status: 200
        content:
          application/json:
            schema: !ref PreviewAnswer
            body: !cel "result"
  - request: { method: POST, path: /generate }
    handler: { kind: Telo.Value, value: {} }
    returns: [{ status: 204 }]
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /api, mount: !ref api }
  - path: /
    mount:
      kind: UiReact.App
      title: Live forms
      theme: !ref UiReact.defaultTheme
      pages:
        - kind: Ui.Page
          path: /preview
          title: Preview
          children:
            - type: composite
              ref:
                kind: Ui.Action
                inputModel: !ref PreviewRequest
                outputModel: !ref PreviewAnswer
                request: { target: /api/preview }
                label: Show
                fields:
                  - kind: Ui.DateRangeField
                    property: period
                    presets: [{ label: This month, unit: month, offset: 0 }, { label: Previous month, unit: month, offset: -1 }]
                    initialPreset: This month
                  - { kind: Ui.InputField, property: columns, control: options }
                  - { kind: Ui.InputField, property: showChart, control: toggle }
                result:
                  type: list
                  rows: !cel "result.items"
                  columns: [{ header: Name, value: !cel "row.name" }, { header: Hours, value: !cel "row.hours" }]
                  rowActions:
                    - action:
                        kind: Ui.Action
                        inputModel:
                          kind: Telo.JsonSchema
                          schema:
                            type: object
                            required: [name, columns, note]
                            properties:
                              name: { type: string }
                              columns: { type: string, enum: [short, full] }
                              note: { type: string, title: Note, minLength: 1 }
                        request: { target: /api/generate }
                        label: Generate
                        onSuccess: { refreshes: [/api/preview] }
                      inputs: { name: !cel "row.name", columns: !cel "input.columns" }
                      prompt: true
```

**After** — the preview page places the form and, beside it, a query node whose query names it in `form`, plus a team board that follows the same form; the Generate row button asks for a note through a `Ui.Prompt`; a create page opens the person it created; the app gains a draft editor with an override of the saving text:

```yaml
kind: Telo.Application
metadata: { name: FormEvents }
lang: en
imports:
  Http: ../../../../http-server
  Ui: ../../../
  UiReact: ../../../../ui-react
  DataModel: ../../../../data-model
ports: { http: { env: PORT, protocol: tcp, default: 8160 } }
translations:
  catalogs: [{ kind: Ui.Translations, lang: en, messages: { saving: Saving the draft…, retry: Try again } }]
targets:
  - !ref server
---
kind: Telo.JsonSchema
metadata: { name: PreviewRequest }
schema:
  type: object
  additionalProperties: false
  required: [period, columns, showChart, team]
  properties:
    period:
      type: object
      additionalProperties: false
      required: [from, to]
      properties: { from: { type: string, format: date }, to: { type: string, format: date } }
    columns: { type: string, enum: [short, full], default: short }
    showChart: { type: boolean, default: false }
    team: { type: string, enum: [north, south], default: north }
---
kind: Telo.JsonSchema
metadata: { name: PreviewAnswer }
schema:
  type: object
  required: [items]
  properties:
    items:
      type: array
      items:
        type: object
        required: [name, hours]
        properties: { name: { type: string }, hours: { type: number } }
---
kind: Telo.JsonSchema
metadata: { name: Person }
schema:
  type: object
  required: [id, name, team, status]
  properties:
    id: { type: integer }
    name: { type: string }
    team: { type: string, enum: [north, south] }
    status: { type: string, enum: [active, away] }
---
# Named: the board lists it and the create page's form writes it.
kind: Ui.CollectionPresentation
metadata: { name: peoplePresentation }
source:
  kind: Ui.CollectionSource
  basePath: /api/people
  collection:
    kind: DataModel.Collection
    model: !ref Person
    schemas:
      create:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [name, team, status]
          properties:
            name: { type: string }
            team: { type: string, enum: [north, south] }
            status: { type: string, enum: [active, away] }
    query: { filters: [{ property: team, operator: eq }, { property: status, operator: eq }], sort: [] }
---
kind: Telo.JsonSchema
metadata: { name: DraftModel }
schema:
  type: object
  additionalProperties: false
  properties: { title: { type: string, title: Title }, body: { type: string, title: Body } }
---
# Named: the preview page places it, and the query and the listing beside it name it.
kind: Ui.Form
metadata: { name: previewForm }
model: !ref PreviewRequest
fields:
  - kind: Ui.DateRangeField
    property: period
    presets: [{ label: This month, unit: month, offset: 0 }, { label: Previous month, unit: month, offset: -1 }]
    initialPreset: This month
  - { kind: Ui.InputField, property: columns, control: options }
  - { kind: Ui.InputField, property: showChart, control: toggle }
  - { kind: Ui.InputField, property: team, control: options }
---
kind: Http.Api
metadata: { name: api }
routes:
  - request: { method: QUERY, path: /preview }
    handler: { kind: Telo.Value, value: { items: [{ name: Ada, hours: 12 }, { name: Grace, hours: 9 }] } }
    returns:
      - status: 200
        content:
          application/json:
            schema: !ref PreviewAnswer
            body: !cel "result"
  - request: { method: POST, path: /generate }
    handler: { kind: Telo.Value, value: {} }
    returns: [{ status: 204 }]
  - request: { method: GET, path: /people }
    handler: { kind: Telo.Value, value: { rows: [{ id: 1, name: Ada, team: north, status: active }], total: 1 } }
    returns:
      - status: 200
        content:
          application/json:
            schema: { type: object, required: [rows, total], properties: { rows: { type: array, items: !ref Person }, total: { type: integer } } }
            body: !cel "result"
  - request: { method: POST, path: /people }
    handler: { kind: Telo.Value, value: { id: 2, name: Grace, team: south, status: active } }
    returns:
      - status: 201
        content:
          application/json:
            schema: !ref Person
            body: !cel "result"
  - request: { method: GET, path: "/people/{id}" }
    handler: { kind: Telo.Value, value: { id: 2, name: Grace, team: south, status: active } }
    returns:
      - status: 200
        content:
          application/json:
            schema: !ref Person
            body: !cel "result"
  - request: { method: PATCH, path: "/people/{id}" }
    handler: { kind: Telo.Value, value: {} }
    returns: [{ status: 204 }]
  - request: { method: POST, path: /posts }
    handler: { kind: Telo.Value, value: { id: "1" } }
    returns:
      - status: 200
        content:
          application/json:
            schema: { type: object, required: [id], properties: { id: { type: string } } }
            body: !cel "result"
  - request: { method: GET, path: "/posts/{id}" }
    handler: { kind: Telo.Value, value: { title: First post, body: Hello } }
    returns:
      - status: 200
        content:
          application/json:
            schema: !ref DraftModel
            body: !cel "result"
  - request: { method: PUT, path: "/posts/{id}" }
    handler: { kind: Telo.Value, value: {} }
    returns: [{ status: 204 }]
  - request: { method: POST, path: "/posts/{id}/publish" }
    handler: { kind: Telo.Value, value: {} }
    returns: [{ status: 204 }]
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /api, mount: !ref api }
  - path: /
    mount:
      kind: UiReact.App
      title: Live forms
      theme: !ref UiReact.defaultTheme
      pages:
        - kind: Ui.Page
          path: /preview
          title: Preview
          children:
            - type: columns
              children:
                - { type: composite, ref: !ref previewForm }
                # Read when the form first holds a valid record, and after every settled change.
                - type: query
                  query:
                    kind: Ui.Query
                    form: !ref previewForm
                    model: !ref PreviewAnswer
                    url: /api/preview
                    input:
                      model: !ref PreviewRequest
                      body:
                        period: !cel "form.period"
                        columns: !cel "form.columns"
                        showChart: !cel "form.showChart"
                        team: !cel "form.team"
                  content:
                    - type: list
                      rows: !cel "data.items"
                      columns: [{ header: Name, value: !cel "row.name" }, { header: Hours, value: !cel "row.hours" }]
                      rowActions:
                        - mutation:
                            kind: Ui.Mutation
                            inputModel:
                              kind: Telo.JsonSchema
                              schema:
                                type: object
                                required: [name, columns, note]
                                properties: { name: { type: string }, columns: { type: string, enum: [short, full] }, note: { type: string } }
                            url: /api/generate
                            invalidates: [/api/preview]
                          inputs: { name: !cel "row.name", columns: !cel "form.columns", note: !cel "prompt.note" }
                          label: Generate
                          prompt:
                            kind: Ui.Prompt
                            model:
                              kind: Telo.JsonSchema
                              schema:
                                type: object
                                required: [note]
                                properties: { note: { type: string, title: Note, minLength: 1 } }
                          result: { type: text, text: Generated }
                          failure: { type: text, text: Not generated — try again later. }
            # Follows the team the form holds, as the query does; dragging a card moves the person.
            - type: composite
              ref:
                kind: Ui.Listing
                form: !ref previewForm
                model: !ref Person
                presentation: !ref peoplePresentation
                filters: { team: !cel "form.team" }
                layout:
                  kind: Ui.BoardLayout
                  groups: { property: status }
                  move:
                    mutation:
                      kind: Ui.Mutation
                      inputModel:
                        kind: Telo.JsonSchema
                        schema:
                          type: object
                          required: [id, status]
                          properties: { id: { type: integer }, status: { type: string, enum: [active, away] } }
                      method: PATCH
                      url: { path: "/api/people/{id}", pathParams: { id: !cel "input.id" } }
                    inputs: { id: !cel "row.id", status: !cel "to.status" }
                    failure: { type: text, text: Not moved. }
        - kind: Ui.Page
          path: /people/new
          title: New person
          children:
            - type: composite
              ref:
                kind: Ui.Form
                model:
                  kind: Telo.JsonSchema
                  schema:
                    type: object
                    required: [name, team, status]
                    properties:
                      name: { type: string, title: Name }
                      team: { type: string, enum: [north, south] }
                      status: { type: string, enum: [active, away] }
                record: { presentation: !ref peoplePresentation }
                afterSubmit: keep
                # The default write's answer is the stored person, typed from the collection's model.
                onSuccess:
                  - { kind: Ui.Navigate, href: { path: "/people/{id}", pathParams: { id: !cel "result.id" } } }
        - kind: Ui.Page
          path: /people/{id}
          title: Person
          children:
            - type: query
              query:
                kind: Ui.Query
                model: !ref Person
                url: { path: "/api/people/{id}", pathParams: { id: !cel "params.id" } }
              content: [{ type: value, value: !cel "data.name" }]
        - kind: Ui.Page
          path: /posts/new
          title: New post
          children:
            - type: button
              action:
                mutation:
                  kind: Ui.Mutation
                  inputModel: { kind: Telo.JsonSchema, schema: { type: object, additionalProperties: false, properties: {} } }
                  outputModel: { kind: Telo.JsonSchema, schema: { type: object, required: [id], properties: { id: { type: string } } } }
                  url: /api/posts
                inputs: {}
                label: Start a draft
                onSuccess:
                  - { kind: Ui.Navigate, href: { path: "/posts/{id}", pathParams: { id: !cel "result.id" } } }
        - kind: Ui.Page
          path: /posts/{id}
          title: Edit post
          children:
            - type: query
              query:
                kind: Ui.Query
                model: !ref DraftModel
                url: { path: "/api/posts/{id}", pathParams: { id: !cel "params.id" } }
              content:
                - type: composite
                  ref:
                    kind: Ui.Form
                    model: !ref DraftModel
                    initialValues: !cel "data"
                    clearAnswerOn: [title]
                    autosave:
                      mutation:
                        kind: Ui.Mutation
                        inputModel:
                          kind: Telo.JsonSchema
                          schema:
                            type: object
                            required: [id]
                            properties: { id: { type: string }, title: { type: string }, body: { type: string } }
                        method: PUT
                        url: { path: "/api/posts/{id}", pathParams: { id: !cel "input.id" } }
                      inputs: { id: !cel "params.id", title: !cel "values.title", body: !cel "values.body" }
                      debounce: 1s
                    onSubmit:
                      mutation:
                        kind: Ui.Mutation
                        inputModel:
                          kind: Telo.JsonSchema
                          schema:
                            type: object
                            required: [id, title, body]
                            properties: { id: { type: string }, title: { type: string, minLength: 1 }, body: { type: string, minLength: 1 } }
                        url: { path: "/api/posts/{id}/publish", pathParams: { id: !cel "input.id" } }
                      inputs: { id: !cel "params.id", title: !cel "values.title", body: !cel "values.body" }
                      label: Publish
                      confirm: Publish this post?
                    onSuccess:
                      - { kind: Ui.Navigate, href: /posts/new }
```

The preview form has no `record`, no `onSubmit` and no `autosave`, so it shows no button; the query node beside it sends one `QUERY /api/preview` when the page is drawn and one after every settled change, and the board reads each status column under `team=north` and again when the team changes; dragging a card to the other column sends `PATCH /api/people/1` with `{ "status": "away" }`. The Generate button on each row asks for a note, sends it with the column choice the form holds, draws "Generated" in its place and reads the preview again. Saving on the create page sends `POST /api/people` and lands on `/people/2`. The editor saves the draft a second after typing stops, asks before publishing, goes to a new draft after publishing, and leaving with an unsaved draft asks the guard's question. A form with a `record` and no `onSubmit` is unchanged and still writes its collection.

Refused, each by `telo check` where it is written:

- the query without its `form` key — `CEL_UNKNOWN_IDENTIFIER` for `form`, "'form' is not available here: the query names no form in `form`";
- `body: { period: !cel "form.perod" }` — `CEL_UNKNOWN_FIELD`;
- `form: !ref PreviewRequest` — `REFERENCE_KIND_MISMATCH`;
- the Generate entry without `label`, `prompt: true`, `label` under the board's `move`, `prompt` or `onSuccess` under `onSubmit`, `confirm` or `label` under `autosave`, and the old `onSuccess: { to: … }` — `SCHEMA_VIOLATION`;
- `{ kind: Ui.Dialog }` in an `onSuccess` list — `REFERENCE_KIND_MISMATCH`;
- a `record` added to the draft form beside its `autosave` and `onSubmit` — `SCHEMA_VIOLATION`;
- the Generate entry's inputs without `note` — `CONTRACT_INPUTS_MISMATCH`; `note: !cel "prompt.note"` on a call with no `prompt` — `CEL_UNKNOWN_IDENTIFIER`;
- an input the mutation does not take (`inputs: { slug: !cel "values.title" }`) — `CONTRACT_INPUTS_MISMATCH`;
- the draft's `autosave` with `method: PUT` removed — `UI_FORM_AUTOSAVE_NOT_IDEMPOTENT`, and the same manifest run from a consumer stops at start with `ERR_UI_FORM_AUTOSAVE_NOT_IDEMPOTENT`;
- `clearAnswerOn: [titel]` — `UI_FORM_CLEAR_UNKNOWN_PROPERTY`;
- the board's `move` mutation with `method: DELETE` — `UI_MUTATION_INPUT_UNSENT`, since `status` travels in no part of the target;
- a `note` of `type: object` in the Generate prompt's model — `UI_FIELD_UNSUPPORTED` at the `Ui.Prompt`;
- `result.titel` in the create page's `onSuccess` — `CEL_UNKNOWN_FIELD`;
- at start, each inputs refusal above is twinned by `ERR_UI_MUTATION_CALL_INPUTS_INVALID`, raised wherever the call's tree is resolved;
- `kind: Ui.Action` — `UNDEFINED_KIND`.

## Decisions

- **A mutation is the write and nothing else.** Its fields, button and answer trees belonged to one caller, and every other caller — a row, a button node, an annotation, an Undo — ignored them while still being held to them; a write declared apart from every trigger is the same write wherever it runs, as TanStack Query's, Apollo's and RTK Query's mutations are.
- **What follows a success belongs to where the write was made.** An autosave never navigates and a submit may; putting it on the mutation made one of them wrong.
- **One closed shape per holder, not one shape with holder-dependent keys.** A `label` "required except on a submit" or a `prompt` "ignored on a submit" is a discriminator hidden in a rule; a closed shape per holder refuses a foreign key with none. Composing them through `allOf` does not work, since a closed sub-schema does not see its `allOf` siblings.
- **A list of effects, not a key per effect.** A success handler that goes somewhere, closes a surface and says so is a sequence in every comparable system — Home Assistant's action lists, Retool's event handlers, a React Query `onSuccess` callback; a key per effect would grow with every effect and fix their order.
- **No limit on destinations in a list.** Effects run in order, so two of them are two moves the author wrote, each after the one before.
- **Effects run in the page shell.** A callback run by the component that made the call is lost when that component unmounts — TanStack Query's documented pitfall — and a form's surface closing after a submit is exactly that.
- **A prompt is its own kind.** A `Ui.Form` at a prompt would accept `record`, `onSubmit`, `autosave` and `afterSubmit`, which mean nothing there and which no rule can refuse; fields written on the call would sit where no rule reaches; deriving the controls from the unbound inputs (`prompt: true`) leaves "an input no control can enter" with no static home. A named shape cannot carry the field rules, which are resource rules and need a kind. An explicit model mapped into the operation's inputs is what Django admin's intermediate forms, Odoo's wizards and Retool's modal forms converge on.
- **A form is a record editor or a mutation form, never both.** Beside a mutation, `record`'s key, merge-patch baseline, validator and write-shape checks would describe a write that is never made, and keeping them as keys "ignored when `onSubmit` is written" would need rules conditioned on which keys are present. Either exclusion can be lifted later without a break.
- **`result` after the default write is the stored record.** Create, then show what was created is the scaffold flow of Rails and Django, and JSON:API, OData and Django REST Framework answer a create with the stored record; withholding it would push every create-then-open page onto a hand-written mutation outside the collection's write checks.
- **One after-success list on the form.** A form makes one submit write; `afterSubmit` stays the form's own lifecycle (`close`, `keep`, `again` are exclusive outcomes of one axis), and the effects follow it.
- **A preview is a query, not a mutation the form fires.** A read fired as an operation needs the operation to promise it has no effect and the page to abort and reorder requests, which no check can hold a route to; a query already drops stale answers and keeps the drawn one.
- **The query names the form; it is not placed inside it.** A form holding the queries it drives would make where a query sits follow where its data comes from, so a query in another cell, a header or an aside could never follow it. Naming the producer at the consumer is what every such system does — a Retool or Appsmith query naming `form1.data`, a Power Apps formula naming `Dropdown1`, HTML's `form` attribute — and in Telo a resource is named by `!ref`, never inside an accessor.
- **A reference on the query, not page-owned state or the address.** Page state would give the values a second owner beside the form; meeting through the address or a shared `state.key` is untyped and flattens structured values into query text.
- **`form` withheld, not nullable, where no form is named.** A binding that can never hold a value is absent: withholding refuses every read of it, while a nullable `form` would pass a guarded read on a query that can never have one. A new "withhold when the slot is empty" annotation would be a second concept beside one that already means this.
- **`form` holds the settled, valid record.** A query sent every keystroke, or an invalid record, would ask the route for answers nobody waits for.
- **`autosave` writes are never aborted.** An aborted write may still have been applied, and the next would then be ordered against an unknown record.
- **`autosave` over a `POST` is refused by `telo check`.** The method is a literal on the mutation and defaults to `POST`, so an autosave over a create route is the easy mistake, and coalescing and resending it creates duplicates. A `PATCH` passes: sending the whole draft, as an autosave does, it replaces like a `PUT`.
- **`concurrency` stays on the mutation.** Whether writes must be ordered is a property of the write's effect on the server, not of the trigger, as TanStack Query's mutation `scope` is.
- **No key on a mutation that makes it run itself.** Whether a write needs a press belongs to where it is run.

## Verify

- A `Ui.Form` with `model` and `fields` and no `record` passes `telo check`; a bare relation property on it is `UI_FIELD_UNSUPPORTED`. Every form with a `record` is unchanged and writes its collection.
- The preview page sends exactly one `QUERY /api/preview` at load, whose body holds `period`, `columns`, `showChart` and `team`; three quick toggles draw only the last answer; typing in a text field sends once after the pause; a toggle or Enter sends at once. The existing `apply: typing` filter tests pass unchanged on the shared rule.
- An invalid period sends nothing, keeps the last preview and shows the finding on the field; with a form that starts invalid the query node draws nothing, not even its loading tree, and sends no request, until the form is valid.
- The same query node placed above the form, in another column, or in a view of its own placed on the page reads the same way; a page holding the query node and not the form sends nothing.
- The preview form placed twice on the page: editing either changes both, and the query reads once per settled change.
- Changing the team reads each board column once under `team=south`; the listing reads nothing while the form has never been valid.
- A row's Generate button asks for a note, then sends the note and the `columns` the form holds at the press, and draws "Generated" in place of the button; an empty note sends nothing.
- `form` read where the query names no form is `CEL_UNKNOWN_IDENTIFIER` with the reason, also inside a query node nested in one whose query names a form; a query node over a named query that names a form types `form`; `form` naming a resource that is not a `Ui.Form` is `REFERENCE_KIND_MISMATCH`.
- `record` beside `onSubmit`, `record` beside `autosave`, and `onSuccess` or `afterSubmit` on a form with neither `record` nor `onSubmit` are each `SCHEMA_VIOLATION`, from `telo check` and the kernel alike. Opened in a drawer with `afterSubmit: close` and `onSuccess: [{ kind: Ui.Navigate, … }]`, a record editor and an `onSubmit` form each close the drawer on success and then land on the address; an `onSubmit` with no `label` is drawn with `ui`'s `save` text.
- A create page whose record form has `onSuccess: [{ kind: Ui.Navigate, href: { path: "/tasks/{id}", pathParams: { id: !cel "result.id" } } }]` passes `telo check`, makes one `POST` and lands on the new record's address; `result.titel` there is `CEL_UNKNOWN_FIELD`; a 2xx body the collection's `model` refuses draws the failure (`ERR_UI_RESPONSE_INVALID`).
- A call's `result.x` over a mutation with no `outputModel` is `CEL_UNKNOWN_FIELD`.
- `label` under a layout's `move` is `SCHEMA_VIOLATION`; a board `move` over a `PATCH` mutation sends it on a drop and draws its failure on the record.
- An `autosave` or `onSubmit` without `inputs` is `SCHEMA_VIOLATION`; a binding the mutation does not take is `CONTRACT_INPUTS_MISMATCH`; the draft example passes `telo check` with optional `title` / `body` bound into required inputs; a binding to a hidden field's property is absent from the request body.
- An `autosave` over a mutation with no `method` is `UI_FORM_AUTOSAVE_NOT_IDEMPOTENT` at check, and the twin stops the same manifest at start from a consumer; with `method: PUT` it passes.
- The draft editor sends nothing at load. Two edits during an in-flight `PUT` produce exactly one more `PUT` with the newest values, under `parallel` and under `serial`; after a no-answer failure, changing a value and back re-sends it; hiding the tab sends a waiting `PUT`.
- A `serial` mutation run from a row button and from an `autosave` sends in press and settle order, one at a time, with exactly one coalesced autosave write.
- A 503 on the draft `PUT` draws the failure and the retry button, sends nothing more until a change or the button, and keeps the form unsaved until a write is acknowledged; no timer is pending.
- One mutation run from `autosave` and from an `onSubmit` of a form whose `onSuccess` holds a `Ui.Navigate`: the autosave leaves the location unchanged, the submit goes there.
- One named mutation run from a row, a `button` node and a form's `onSubmit` sends the same request from each, under one `concurrency`; each draws its own `result` and `failure` where it ran.
- A prompt model property no control can enter is `UI_FIELD_UNSUPPORTED` at the `Ui.Prompt`; `fields: [{ kind: Ui.DateRangeField, property: period }]` on a prompt asks for the period with that field.
- `clearAnswerOn: [title]` on the draft form clears both writes' answers when the title changes; a property the model lacks is `UI_FORM_CLEAR_UNKNOWN_PROPERTY`.
- Every in-repo manifest placing a `Ui.Action` or a bound action passes `telo check` rewritten, and `kind: Ui.Action` is `UNDEFINED_KIND`.
- Pressing Start a draft makes one `POST` and lands on `/posts/1` with no `PUT`; an edit the draft `PUT` mutation's `inputModel` refuses sends nothing, and closing the page asks.
- Typing then clicking a link within the pause asks the guard's question; "keep editing" sends one `PUT` and the next click leaves with no question; reloading with a waiting write shows the browser's prompt.
- The `GET` that follows a save never replaces values typed during it.
- Publish with an empty `title`: nothing is sent, the finding is on the field, the button stays enabled, typing a title clears it; a successful Publish lands on `/posts/new`.
- The draft editor's saving and retry texts are the `Ui.Translations` override's wording; without the override they are the English source wording.
- An `autosave` that omits `debounce` carries `300`, `debounce: 1s` carries `1000`, on the wire; a query spec or listing naming no form carries `form: null`, a call with no prompt `prompt: null`, and each form node carries its `id`.

## Bookkeeping

Run `telo release floor` with the change — `ui` adopts the widened `x-telo-context-withheld` reading and the list form of `x-telo-context-ref-from`. Analyzer: the three annotation widenings, with `CONTEXT_WITHHELD_INVALID` relaxed beside `x-telo-context-ref-from` (a withheld node there may carry the JSON Schema keywords of its own reading, and one beside both typing annotations is refused) and the new `CONTEXT_REF_FROM_INVALID`; documented in `docs/extend/referrer-typed-bindings.md` and the analyzer guide. `ui`'s tests pin `UI_FORM_AUTOSAVE_NOT_IDEMPOTENT` both ways — refused at the declaring manifest, and `runFails:` from a consumer. Docs: `ui` `action.md` replaced by `mutation.md` (the mutation, the call shapes, prompting, `concurrency` with an autosave), `action-contract.md` renamed `mutation-contract.md`; `form.md` (the free-standing form, a query following a form placed elsewhere, `onSubmit`, `onSuccess` and the order after a submit, `autosave` and its idempotency, `clearAnswerOn`, the draft editor); `nodes.md` (the `button` node and every row action and annotation holding a call); `listing.md`, `listing-layouts.md` (`move`), `query.md` on `form` and the `form` root; `surfaces.md` §unsaved input; `filters.md` and the controls contract for the settle rule; `texts.md` and the translations; `data-model` `collection-contract.md` (`POST` answers with the stored record), with `Crud.Api` pinned to it; the `refreshes` → `invalidates` rename across `ui`'s schema, `Ui.Chat` docs and examples; `ui-react` `parts.json` and `styling.md` (the action section becomes mutation answers); `ui-react` `urls.md` and the component ABI where a component runs a call. Every in-repo manifest placing a `Ui.Action` or a bound action (`examples/ui-showcase`, `examples/chat`, `examples/report-console`, and the `ui` and `crud-ui` tests). The ui README's kind table and benefits list, the Declarative UI paragraph of `modules/CLAUDE.md`, the authoring-agent primer and the hub `build-ui` guide. Benefits-ledger entries under Standard library: "Live preview and autosave", and the entry on buttons that run an operation rewritten around mutations run from anywhere. `Added` fragments describing the break for `ui`, `ui-react` and `crud-ui`.
