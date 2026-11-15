---
status: draft
priority: medium
depends-on: [2026-11-15-ui-record-pages.md, 2026-11-15-ui-query-reads.md]
packages: [modules/ui, modules/ui-react, modules/crud-ui, examples/ui-showcase, examples/chat, examples/report-console, apps/hub, apps/authoring-agent, docs]
refinement: not-started
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

- `Ui.Mutation` — a declared write: `inputModel`, `outputModel?`, `method?`, `url`, `refreshes?`, `concurrency?`. It draws nothing.
- `Ui.Effect` — abstract over what happens after a call answers; `Ui.Destination` and its kinds extend it.
- `Ui.MutationCall` — named shape `{ mutation, inputs, label?, confirm?, prompt?, enabled?, onSuccess?, result?, failure? }`: a mutation run with inputs bound from the data in scope, and what is drawn from its answer where it ran.
- `Ui.Form.onSubmit` — a `Ui.MutationCall`: run when the form is submitted.
- `Ui.Form.onChange` — `{ mutation, inputs, debounce?, result?, failure? }`: run when the values settle; `debounce` a `Telo.Duration` of at least `0s`, default `300ms`.
- `Ui.Form.clearAnswerOn` — form properties whose change clears what its events drew from their last answers.
- `UI_FORM_CLEAR_UNKNOWN_PROPERTY` (twin `ERR_UI_FORM_CLEAR_UNKNOWN_PROPERTY`) — `clearAnswerOn` naming a property the form's `model` does not declare.
- `Ui.Query.form` — a reference to the `Ui.Form` whose values the query reads; binds the `form` root in its `url` and `body`, and in the trees of every `query` node drawing it.
- `Ui.Listing.form` — the same for a listing: binds `form` in its `filters` and its row actions.
- The `form` root — a browser root where a query or listing names a form: the form's settled, valid record, typed from its `model`.
- Wire: a `Ui.MutationSpec` `{ id, schema, answer?, method, url, consumed, refreshes, concurrency }`; a call `{ mutation, inputs, label, confirm?, prompt?, enabled?, onSuccess, result?, failure }`, `onSuccess` a list of effect specs (`[]` when none), wherever a bound action was; the `form` node's `id`, `onSubmit`, `onChange` (`debounce` in integer milliseconds) and `clearAnswerOn`; `form` on the query spec and the `listing` node (the form's id, `null` when none).
- Keyed texts `formSaving` and `formRetry` in `Ui.Translations` and its fourteen translations.
- `aria-busy` on a form's event region while an `onChange` write is awaited.
- `modules/ui/conformance/form-events.json` — the renderer-neutral vectors `ui-react` runs.

**Changed**

- Every place that ran an action — a listing's and a `list` node's `rowActions`, a layout's `move`, a markdown node's `annotations.action`, the `button` node — holds a `Ui.MutationCall`: `action:` becomes `mutation:`, and the call carries its own `label`, `result` and `failure`.
- `onSuccess` — moves from the write to the call and becomes a list of effects, `Ui.MutationCall.onSuccess: [<Ui.Effect>…]`; `onSuccess.to` is gone (`SCHEMA_VIOLATION`).
- `Ui.Destination` — extends `Ui.Effect`, so `Ui.Navigate`, `Ui.OpenPage` and `Ui.Close` are effects.
- `prompt` — `true` asks for every property of the mutation's `inputModel` that the inputs leave unbound, each with its derived control; `{ fields, groups? }` names the fields, as a form's `fields` do.
- `Ui.Form.record` — becomes optional. Without it the form has no collection: no relation pickers and no default write.
- `Ui.Form` binds `values`, `params` and `query` at an event's `inputs`, typed from where the form is placed.
- The form's `data-state` value `submitting` also covers an `onChange` request in flight or held.
- A form is unsaved, for its `unsaved` guard, also while an `onChange` write is waiting, in flight or failed.
- The settle rule for entered values (a choice or a commit at once, typed text after a pause) is stated once in the controls contract and cited by `filters.md` and `form.md`.
- `UI_ACTION_INPUT_UNSENT` → `UI_MUTATION_INPUT_UNSENT`, `ERR_UI_BOUND_ACTION_INPUTS_INVALID` → `ERR_UI_MUTATION_CALL_INPUTS_INVALID`; the action contract is the mutation contract, unchanged in what it requires of a route.

**Removed**

- `Ui.Action` — an unknown kind (`UNDEFINED_KIND`); its wire `action` node with it. A form and a button that run one write are a `Ui.Form` with `onSubmit`; a bare button is a `button` node.
- `Ui.BoundAction` — `Ui.MutationCall` replaces it.
- `UI_ACTION_CLEAR_UNKNOWN_PROPERTY` — `UI_FORM_CLEAR_UNKNOWN_PROPERTY` replaces it.

## Solution

**A mutation is the write, as a query is the read.** `Ui.Mutation` holds everything about the request and nothing about drawing: `inputModel` (the record it takes), `outputModel` (the shape of a success's body), `method` and `url` under the mutation contract (`method` `POST` by default, `PUT`, `PATCH` or `DELETE`, `GET` and `QUERY` refused; `url` a `Ui.RequestTarget` over `input`, consuming input properties exactly as `Ui.Action`'s `request.target` did, the body being the input minus what `url` consumes), `refreshes` (the request targets announced after a success, with the `*` / `**` wildcards), and `concurrency` (`parallel` or `serial`, across every call of the mutation on the page). It has no fields, no button and no answer trees, so it is the same write wherever it runs. This is the pair TanStack Query, Apollo and RTK Query declare: a query to read, a mutation to write, and the components that run them apart from both.

**A call runs one, where it is.** `Ui.MutationCall` is the one shape every trigger holds: `mutation` (a `!ref` or one inline), `inputs` (bound from the roots in scope, judged against `inputModel` as today, `{}` for a mutation that takes nothing), `label` (the button's text; required except on a form's `onSubmit`, where `ui`'s `save` text is the default), `confirm`, `prompt`, `enabled`, `onSuccess`, and the `result` tree over `result` and `input` and the `failure` tree over `error` and `input` (`ui` filling the failure). What follows a success depends on where the write was made, so it is the call's: one mutation saves and stays from an autosave, saves and navigates from a submit, and saves silently from a row.

**After a success, a list of effects.** `onSuccess` is a list, each entry a `Ui.Effect` written inline: today a destination — `Ui.Navigate`, `Ui.OpenPage`, `Ui.Close` — over `result` and `input`. The effects run in the order written, each after the one before has happened, so `[{ kind: Ui.Close }, { kind: Ui.Navigate, href: … }]` closes the surface the call ran in and then moves the page. `Ui.Effect` is an abstract (`x-telo-ref`, kind `Ui.Effect`, at each entry), so an effect kind added later — another module's, or a notification — is accepted with no change to the call, and anything but an effect is `REFERENCE_KIND_MISMATCH`. `refreshes` stays on the mutation: which reads a write invalidates is the write's, wherever it ran.

**Prompting.** `prompt: true` opens a dialog asking for every property of the `inputModel` the inputs leave unbound, each entered with its derived control; `prompt: { fields, groups? }` names the fields and their kinds, as a form's `fields` do. The dialog holds the bound and entered values together to the whole `inputModel`. A required property left unbound is `CONTRACT_INPUTS_MISMATCH` without a prompt, and `UI_FIELD_REQUIRED_NOT_ENTERED` / `UI_FIELD_UNSUPPORTED` at the call when the prompt cannot enter it. The fields belong to the call that asks, so a mutation run from a row needs no fields of its own.

**A form and a button that run one write** — what `Ui.Action` was — is a `Ui.Form` with `onSubmit`. Its `model` is what the person enters, `onSubmit.inputs` maps it onto the mutation's `inputModel`, its `enabled` reads `values`, and its answer is drawn beneath the fields. A bare button is `{ type: button, mutation, inputs: {}, label }`.

**`record` becomes optional.** Without it, `model` and `fields` are all the form needs: a bare property is entered with the control its type calls for, and a relation is entered by an explicit `Ui.PickerField`, which carries its own options (a bare relation property is `UI_FIELD_UNSUPPORTED`). A form with neither `record` nor `onSubmit` shows no submit button; with no `onChange` either it is legal, and its values are read by its own `shown` conditions, by forms sharing its `state.key`, and by every query or listing naming it in `form`.

**What is shown follows the values, wherever it is placed.** A query names the form it reads, as an HTML `<input form="…">` or `<output for="…">` names a form placed elsewhere in the document: `Ui.Query.form: !ref previewForm`. That binds the `form` root in the query's `url` and `body` and in the `loading`, `children` and `failure` trees of every `query` node drawing it (typed through the node's slot, `x-telo-context-ref-from: "query/form/model"`), so `body: { period: !cel "form.period" }` sends the form's period and a row action inside the answer binds `form.columns` in its inputs. `Ui.Listing.form` does the same for a listing's `filters` and row actions. The query node and the form are placed independently — side by side, in another cell, under a tab, in a view of its own — so layout never follows data flow. `form` is the form's record once it has settled and is valid against its `model`:

- **Settling.** A choice or a control's commit (Enter, leaving the field, release) settles at once; typed text settles after the typing pause. This is the rule `apply: typing` on a filter bar already follows, stated once.
- **Validity.** While the entered record is invalid, `form` keeps the last valid record and the fields show their findings. Until the form first holds a valid record it holds nothing, and a query whose `url` or `body` reads it is not sent and its nodes draw nothing — not even their `loading` tree — so an invalid start shows no loading indicator.
- **Reading.** A query reads again when the request its `url` and `body` resolve to changes — at most one read in flight, an answer to an earlier request never drawn, the drawn answer kept while the next is awaited.

**Typed from the form, checked by `telo check`.** `form` is a reference slot (`x-telo-ref`, `use: schema`, kind `Ui.Form`), and the root is typed by the existing `x-telo-context-ref-from: "form/model"`, accessor-only like every browser root — so `form.perod` is `CEL_UNKNOWN_FIELD`, `form` read where the query names no form is `CEL_UNKNOWN_IDENTIFIER`, and a slot naming anything but a form is `REFERENCE_KIND_MISMATCH`. A query node nested in another keeps the enclosing one's `form` unless its own query names one, as every nested region adds to the one around it. No part of the analyzer names a form.

**Where the form is not drawn.** A query whose form is not on the page being drawn reads nothing and its nodes draw nothing, as for a `url` that holds nothing.

**One form, one record per page.** A form placed twice on one page is one record: both placements show and edit the same values, as two filter bars sharing a `state.key` share their state. The renderer keeps the settled record per form id for as long as the page is drawn, and a query finds it by the id its spec carries.

So the live preview is a form and a query node placed wherever the page wants them: the query reads once when the form first holds a valid record and again after every settled change, with no press, no debounce key and no rule about methods — the read is a `GET`, or a `QUERY` or `POST` when it sends a body.

**`onSubmit`.** Omitted, a submit is the form's default write to its `record`. Pressed, the record is judged against the called mutation's `inputModel`: invalid sends nothing and puts the findings on the fields until a field changes; valid flushes `onChange` writes, waits for them, and is not sent if one fails. The form's `afterSubmit` applies after an `onSubmit` success as after its default write, and the call's `onSuccess` effects after that.

**`onChange` — saving as it is edited.** `onChange` is for a write that replaces: an autosave. It is sent when the bound record is valid against the called mutation's `inputModel`, differs from the baseline and is not the one already in flight. The baseline is the newest record the server acknowledged — the form's starting record at first — and a failure clears it, since the outcome is unknown. So nothing is sent at start, and after a failure any valid record, a reverted one included, is sent. A choice or a commit sends at once and typed text after `debounce`; the page becoming hidden sends a waiting write. A change made while a write is pending is held, the newest replacing older, and sent when the pending one answers: a write is never aborted and never reordered. Because changes are coalesced and a failed write is sent again, the mutation must be idempotent — a `PUT` or a `PATCH` of the whole draft — which `form.md` states and nothing checks; creating a record belongs to a pressed call. `onChange` has no `label`, `confirm`, `prompt`, `enabled` or `onSuccess` (`SCHEMA_VIOLATION`): it is never pressed and never navigates.

**What an event sends.** `inputs` is required and read like any call's: judged statically against the mutation's `inputModel`, so a binding it does not take is `CONTRACT_INPUTS_MISMATCH`. The roots in scope at an event's `inputs` are `values`, `params` and `query`. There `values` is the record the form holds now, typed from `model`; `required` never changes a type, so `values.title` of an optional property is a string, and whether it is present is judged at run time against the `inputModel`. An input reading a property whose field is hidden or empty reads nothing and is left out of the record sent.

**Findings while editing.** For each event the record is judged against the called mutation's `inputModel` as values are entered, and an invalid one sends nothing and says why: a finding lands on the field a bound input names as exactly `values.<property>`, by the form's touched-field rule, and any other finding is drawn in the event's region. A field shows the form's `model` findings first, then each event's, identical wording once. A 400's issues land by the same rule.

**What is drawn.** Beneath the fields: each event's `result` and `failure` trees, over `result`, `input` (the record sent) and `values` (what the form holds now). While an `onChange` write is awaited the answer stays, `aria-busy` is set and `formSaving` is drawn beside it. The form's `data-state` is `idle`, `submitting` (in flight, or held behind one) or `error`. A failure replaces the event's answer with its `failure` tree plus a `formRetry` button and lasts until the next change or that button — nothing is retried automatically. A change to a property `clearAnswerOn` lists clears both events' answers. No styling part is added.

**Unsaved, and leaving.** A form with `onChange` is unsaved while its record differs from its baseline — sendable or not — or a write is waiting or in flight, or the last write failed and none has been acknowledged since. Its `unsaved` key governs as for any form: `confirm` asks before a move that closes it, "keep editing" leaving the waiting write to send as scheduled and "discard" dropping it; an in-flight write is not aborted. Nothing is sent with `keepalive`, so a stuck server never blocks navigation. A form with no write is never unsaved.

**Autosave only replaces.** A pressed `POST` mutation creates the draft and the call's `onSuccess` goes to the editor's address built from `result.id`; the editor reads the draft with a `query` node, whose children place a `Ui.Form` with `initialValues` over `data`, a `PUT` `onChange` whose mutation's `inputModel` is loose, and an `onSubmit` Publish whose mutation's `inputModel` is strict. The query re-reads after every save, which keeps the form and what was typed since. Two tabs editing one draft: where the draft's route sends an `ETag`, the second tab's save answers `412`, draws the failure with its retry button, and its query reads again; where it sends none, the last write wins.

**No migration.** Splitting an action into a form, a call and a mutation is a structural move a data migration does not make; in-repo manifests are updated and the `ui` fragment describes the break.

## Example

The application is the fixture `modules/ui/tests/__fixtures__/form-events/telo.yaml`, serving both screens: the preview of issue #822 and a draft editor. Before, the preview is a `POST` route behind a `Ui.Action` composite whose Show button the person presses after every change, and there is no draft editor. After, the preview page places the form and, beside it, a query node whose query names it in `form`, and the app gains a draft editor with a `Ui.Translations` override of the saving text:

```yaml
kind: Telo.Application
metadata: { name: FormEvents }
lang: en
imports:
  Http: ../../../../http-server
  Ui: ../../../
  UiReact: ../../../../ui-react
ports: { http: { env: PORT, protocol: tcp, default: 8160 } }
translations:
  catalogs: [{ kind: Ui.Translations, lang: en, messages: { formSaving: Saving the draft…, formRetry: Try again } }]
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
metadata: { name: DraftModel }
schema:
  type: object
  additionalProperties: false
  properties: { title: { type: string, title: Title }, body: { type: string, title: Body } }
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
kind: Ui.DateRangeField
metadata: { name: periodField }
property: period
presets: [{ label: This month, unit: month, offset: 0 }, { label: Previous month, unit: month, offset: -1 }]
initialPreset: This month
---
# Named: the preview page places it, and the query beside it names it.
kind: Ui.Form
metadata: { name: previewForm }
model: !ref PreviewRequest
fields:
  - !ref periodField
  - { kind: Ui.InputField, property: columns, control: options }
  - { kind: Ui.InputField, property: showChart, control: toggle }
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
            schema: { type: object, properties: { title: { type: string }, body: { type: string } } }
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
                    method: QUERY
                    url: /api/preview
                    body:
                      period: !cel "form.period"
                      columns: !cel "form.columns"
                      showChart: !cel "form.showChart"
                  children:
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
                                required: [name, columns]
                                properties: { name: { type: string }, columns: { type: string, enum: [short, full] } }
                            url: /api/generate
                          inputs: { name: !cel "row.name", columns: !cel "form.columns" }
                          label: Generate
        - kind: Ui.Page
          path: /posts/new
          title: New post
          children:
            - type: button
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
              children:
                - type: composite
                  ref:
                    kind: Ui.Form
                    model: !ref DraftModel
                    initialValues: !cel "data"
                    onChange:
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
```

The preview form has no `record`, no `onSubmit` and no `onChange`, so it shows no button; the query node beside it sends one `QUERY /api/preview` when the page is drawn and one after every settled change, and the Generate button on each row reads the column choice the form holds. The editor saves the draft a second after typing stops, asks before publishing, and leaving with an unsaved draft asks the guard's question. A form with a `record` and no `onSubmit` is unchanged and still writes its collection.

Refused, each by `telo check` where it is written: the query without its `form` key reports `CEL_UNKNOWN_IDENTIFIER` for `form`; `body: { period: !cel "form.perod" }` reports `CEL_UNKNOWN_FIELD`; `form: !ref PreviewRequest` reports `REFERENCE_KIND_MISMATCH`; an `onChange` without `inputs` reports `SCHEMA_VIOLATION` at the event; an input the mutation does not take (`inputs: { slug: !cel "values.title" }`) reports `CONTRACT_INPUTS_MISMATCH`; `confirm` or `label` under `onChange` reports `SCHEMA_VIOLATION`; the Generate entry without `label` reports `SCHEMA_VIOLATION`; `kind: Ui.Action` reports `UNDEFINED_KIND`.

## Decisions

- **A mutation is the write and nothing else.** Its fields, button and answer trees belonged to one caller, and every other caller — a row, a button node, an annotation, an Undo — ignored them while still being held to them; a write declared apart from every trigger is the same write wherever it runs, as TanStack Query's, Apollo's and RTK Query's mutations are.
- **What follows a success belongs to the call.** An autosave never navigates and a submit may; putting it on the mutation made one of them wrong.
- **A list of effects, not a key per effect.** A success handler that goes somewhere, closes a surface and says so is a sequence in every comparable system — Home Assistant's action lists, Retool's event handlers, a React Query `onSuccess` callback; a key per effect would grow with every effect and fix their order.
- **No limit on destinations in a list.** Effects run in order, so two of them are two moves the author wrote, and a rule refusing them would refuse closing a surface before moving the page.
- **A preview is a query, not a mutation the form fires.** A read fired as an operation needs the operation to promise it has no effect and the page to abort and reorder requests, which no check can hold a route to; a query already drops stale answers and keeps the drawn one.
- **The query names the form; it is not placed inside it.** A form holding the queries it drives would make where a query sits follow where its data comes from, so a query in another cell, a header or an aside could never follow it. Naming the producer at the consumer is what every such system does — a Retool or Appsmith query naming `form1.data`, a Power Apps formula naming `Dropdown1`, HTML's `form` attribute — and in Telo a resource is named by `!ref`, never inside an accessor.
- **A reference on the query, not page-owned state or the address.** Page state would give the values a second owner beside the form; meeting through the address or a shared `state.key` is untyped and flattens structured values into query text.
- **`form` holds the settled, valid record.** A query sent every keystroke, or an invalid record, would ask the route for answers nobody waits for.
- **`onChange` writes are never aborted.** An aborted write may still have been applied, and the next would then be ordered against an unknown record.
- **No key on a mutation that makes it run itself.** Whether a write needs a press belongs to where it is run.

## Verify

- A `Ui.Form` with `model` and `fields` and no `record` passes `telo check`; a bare relation property on it is `UI_FIELD_UNSUPPORTED`. Every form with a `record` is unchanged and writes its collection.
- The preview page sends exactly one `QUERY /api/preview` at load, whose body holds `period`, `columns` and `showChart`; three quick toggles draw only the last answer; typing in a text field sends once after the pause; a toggle or Enter sends at once. The existing `apply: typing` filter tests pass unchanged on the shared rule.
- An invalid period sends nothing, keeps the last preview and shows the finding on the field; with a form that starts invalid the query node draws nothing, not even its loading tree, until the form is valid.
- The same query node placed above the form, in another column, or in a view of its own placed on the page reads the same way; a page holding the query node and not the form sends nothing.
- The preview form placed twice on the page: editing either changes both, and the query reads once per settled change.
- A row's Generate button sends the `columns` the form holds at the press.
- `form` read where the query naming no form is drawn is `CEL_UNKNOWN_IDENTIFIER`; `form` naming a resource that is not a `Ui.Form` is `REFERENCE_KIND_MISMATCH`; a listing with `form` filtering by `form.period` follows the form as a query does.
- A form with a `record` and an `onSubmit` sends the mutation, not the default write, and still offers the relation pickers; its `afterSubmit: close` closes the surface it is open in after the mutation succeeds; an `onSubmit` with no `label` is drawn with `ui`'s `save` text.
- An `onChange` or `onSubmit` without `inputs` is `SCHEMA_VIOLATION`; a binding the mutation does not take is `CONTRACT_INPUTS_MISMATCH`; the draft example passes `telo check` with optional `title` / `body` bound into required inputs; a binding to a hidden field's property is absent from the request body.
- The draft editor sends nothing at load. Two edits during an in-flight `PUT` produce exactly one more `PUT` with the newest values, under `parallel` and under `serial`; after a no-answer failure, changing a value and back re-sends it; hiding the tab sends a waiting `PUT`.
- A 503 on the draft `PUT` draws the failure and the retry button, sends nothing more until a change or the button, and keeps the form unsaved until a write is acknowledged; no timer is pending.
- One mutation run from `onChange` and from an `onSubmit` whose `onSuccess` holds a `Ui.Navigate`: the autosave leaves the location unchanged, the submit goes there; `onSuccess` under `onChange` is `SCHEMA_VIOLATION`.
- One named mutation run from a row, a `button` node and a form's `onSubmit` sends the same request from each, under one `concurrency`; each draws its own `result` and `failure` where it ran.
- A row call with `prompt: true` over a mutation whose `inputModel` has an unbound required `note` asks for `note` with a text input; one whose unbound required property no control can enter is `UI_FIELD_UNSUPPORTED` at the call; `prompt: { fields: [{ kind: Ui.DateRangeField, property: period }] }` asks for the period with that field.
- `clearAnswerOn: [period]` on the preview form clears both events' answers when the period changes; a property the model lacks is `UI_FORM_CLEAR_UNKNOWN_PROPERTY`.
- Every in-repo manifest placing a `Ui.Action` or a bound action passes `telo check` rewritten, and `kind: Ui.Action` is `UNDEFINED_KIND`.
- Pressing Start a draft makes one `POST` and lands on `/posts/1` with no `PUT`; an edit the draft `PUT` mutation's `inputModel` refuses sends nothing, and closing the page asks.
- Typing then clicking a link within the pause asks the guard's question; "keep editing" sends one `PUT` and the next click leaves with no question; reloading with a waiting write shows the browser's prompt.
- The `GET` that follows a save never replaces values typed during it.
- Publish with an empty `title`: nothing is sent, the finding is on the field, the button stays enabled, typing a title clears it.
- With the draft route sending an `ETag`, a save from a second tab answers `412`, draws the failure and the retry button, and its query reads again.
- The draft editor's saving and retry texts are the `Ui.Translations` override's wording; without the override they are the English source wording.
- An `onChange` that omits `debounce` carries `300`, `debounce: 1s` carries `1000`, on the wire; a query spec or listing naming no form carries `form: null`, and each form node carries its `id`.

## Bookkeeping

Run `telo release floor` with the change. Docs: `ui` `action.md` replaced by `mutation.md` (the mutation, the call, prompting), `action-contract.md` renamed `mutation-contract.md`; `form.md` (the free-standing form, a query following a form placed elsewhere, `onSubmit`, `onChange` and the idempotency its mutation must have, `clearAnswerOn`, the draft editor); `nodes.md` (the `button` node and every row action and annotation holding a call); `listing.md`, `listing-layouts.md` (`move`), `query.md` on `form` and the `form` root; `surfaces.md` §unsaved input; `filters.md` and the controls contract for the settle rule; `texts.md` and the translations; `ui-react` `urls.md` and the component ABI where a component runs a call. Every in-repo manifest placing a `Ui.Action` or a bound action (`examples/ui-showcase`, `examples/chat`, `examples/report-console`, and the `ui` and `crud-ui` tests). The ui README's kind table and benefits list, the Declarative UI paragraph of `modules/CLAUDE.md`, the authoring-agent primer and the hub `build-ui` guide. Benefits-ledger entries under Standard library: "Live preview and autosave", and the entry on buttons that run an operation rewritten around mutations run from anywhere. `Added` fragments describing the break for `ui`, `ui-react` and `crud-ui`.
