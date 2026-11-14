---
status: draft
priority: medium
depends-on: []
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/ui-react-conformance, apps/hub, apps/authoring-agent, docs]
refinement: not-ready
---

# Forms whose values feed an operation without a press

## Problem

A form in a screen is submitted only by pressing. `Ui.Action` is a button with its own form; `Ui.Form` writes a collection through a listing's opener. Nothing is a form whose values drive an operation by themselves, so two things cannot be built:

- **A live preview** (issue #822). A page's main element is a period and a few display options, posted to a read route, with the matching records listed under it and a row button running the real operation from those values. Today the person presses Show after every change, though the route has no side effects. The only debounced reaction in `ui` is `Ui.Filters.policy.apply: typing`, which drives a listing over a collection, not an operation.
- **Autosave of a draft before publishing.** An editor loses its edits unless Save is pressed; nothing says "saving", and leaving the page does not warn.

Making the button press itself is the wrong model: whether a call needs a press is a property of where it is made (the same preview action is also pressed from a row), not of the operation.

## Surface

**Added**

- `Ui.ActionForm` — a `Telo.Provider` extending `Ui.Composite`: a form with no destination whose values feed calls of `Ui.Action`s. Keys `model`, `fields`, `groups`, `state`, `initialValues`, `footer`, `liveCalls`.
- `Ui.LiveCall` — an entry of `liveCalls`: `{ action, inputs, debounce? }`; `action` and `inputs` are `Ui.BoundAction`'s own, `inputs` reading `values` and the roots of the place holding the form (`data`, `params`, `query`); `debounce` is a `Telo.Duration` of at least `0s`, default `300ms`.
- `Ui.FieldEntry` — named shape for one `fields` entry (a property name or a field kind).
- `type: action-form` — wire spec node: `schema`, `fields`, `groups`, `state`, `initialValues` (an accessor binding), `footer` (nodes), `liveCalls[] { action, inputs, debounce }` with `debounce` in integer milliseconds.
- `UI_LIVE_CALL_UNSAFE` (`ERR_UI_LIVE_CALL_UNSAFE`) — a live call whose action is neither `latest` nor a `PUT`.
- `UI_ACTION_LATEST_UNSAFE` (`ERR_UI_ACTION_LATEST_UNSAFE`) — `latest` on an action sending `PUT`, `PATCH` or `DELETE`.
- Styling parts `action-form` and `live-call`, taking the existing `data-state` values `idle`, `submitting`, `error`; the retry button and the saving text reuse the existing `button` and `loading` parts.
- Keyed texts `liveCallSaving` and `liveCallRetry` in `Ui.Translations` and its fourteen translations.
- `modules/ui/conformance/live-calls.json` — the renderer-neutral vectors `ui-react` runs; `modules/ui/docs/action-form.md`.

**Changed**

- `Ui.Action.concurrency` (and the wire `action` spec's `concurrency`) gains `latest`, and its description becomes: every entry runs one request at a time; `parallel` runs entries at once, `serial` in page order, `latest` lets an entry replace its pending request and declares that the operation has no effect — nothing checks it.
- The wire spec node union gains `action-form`; the existing leave guard (`surfaces.md`) is now also held by `Ui.ActionForm`.
- `Ui.Form.fields` and `Ui.Action.fields` entries are typed by `Ui.FieldEntry` (what they accept is unchanged).
- `Ui.InputField`, `Ui.ChoiceField`, `Ui.PickerField`, `Ui.DateRangeField` — each restates its fit rules once per holder of a field, so each gains a copy for `Ui.ActionForm`.

**Removed** — none.

## Solution

**Three things, three homes.** The values are the form's, the request and its answer are the action's, the trigger is the call site's — the split `Ui.BoundAction` already makes for rows and `button` nodes.

**`Ui.ActionForm`.** `model` types `values` and adds its own findings as values are entered. `fields`, `groups` and `state` are `Ui.Form`'s grammar and codes, restated on the kind; `UI_FIELD_REQUIRED_NOT_ENTERED` is left out (the form sends no record of its own). `initialValues` is a plain chain over the place's roots, held to fit `model`, read once at start; precedence is `initialValues`, the address, the store, then the model's defaults and a date range's `initialPreset`, and a reader reading again never replaces what the form holds. `footer` is a node tree over `values`, `data`, `params` and `query`; its `button` nodes run pressed calls. `liveCalls` is a list of `Ui.LiveCall`. A page places the form as any composite.

**What a live call takes from its action:** `inputModel` (the gate), `request`, `outputModel`, `result`, `failure`, `onSuccess.refreshes`, `concurrency`, `clearAnswerOn`, and `label` as the region's accessible name. It never draws `fields`, `groups`, `state`, `enabled` or `onSuccess.navigate` — a press owns those, and a live call never navigates — so one action serves as autosave and as a "Save and close" button. The action keeps its own field rules wherever it is called from: it lists a field for every required property it cannot enter by default (a date range), as its form would if pressed.

**When a live call is sent.** When its bound record is valid against the called action's `inputModel`, differs from the call's baseline and is not the one already in flight. The baseline is the newest record the server acknowledged — the form's starting record for a write, none under `latest` — and a failure clears it, since the outcome is unknown. So a valid `latest` call sends once at start, a write never does, and after a failure any valid record, a reverted one included, is sent. A choice or a control's `onCommit` (Enter, leaving the field, release) sends at once and typed text after `debounce` — the rule `Ui.Filters.policy.apply: typing` already follows, defined once in `ui-react`'s controls contract and cited by `filters.md` and `action-form.md`; the page becoming hidden sends a waiting write (a backgrounded tab; closing it raises the prompt below). `live-calls.json` pins this over renderer-neutral events (change, commit, hidden, press, answer, leave, elapsed time) and names no control. A live call is sent by an edit only: it does not read announcements, so a row action's `refreshes` does not send it again.

**Findings while editing.** The record is judged against the called action's `inputModel` as values are entered, and an invalid one sends nothing, keeps the answer and says why: a finding lands on the field a bound input names as exactly `values.<property>`, by the form's touched-field rule, and any other finding is drawn in the live call's region beside the answer. A field shows the form's `model` findings first, then each live call's in order, identical wording once. A 400's issues and the findings of a pressed footer button land by the same rule. An invalid record at start draws no loading indicator.

**Concurrency.** A live call is one entry; a change made while its request is pending is held, the newest replacing older, because a change cannot be refused as a press is. Under `latest` it aborts the pending request and sends the new record — an aborted request draws nothing, only the newest answer is drawn. A write is never aborted. `UI_ACTION_LATEST_UNSAFE` keeps `latest` to an action that cannot reorder a write; `UI_LIVE_CALL_UNSAFE` holds a live call to `latest` or `PUT`, so a `POST` creating a record at every pause fails `telo check`. `confirm`, `prompt` and `enabled` are not keys of `Ui.LiveCall` (`SCHEMA_VIOLATION`); `inputs` are judged as any call's against the action's `inputModel`.

**What is drawn.** Each live call draws its action's `result` and `failure` trees beneath the footer, over the action's `result`, `input` and `values` (the record sent); the form has no answer tree. While a different valid record is awaited the answer stays and `aria-busy` is set: a `latest` call draws `ui`'s `loading` text beside it, a write `liveCallSaving`, and before the first answer `ui`'s loading indicator. `data-state` is `idle` (including the wait), `submitting` (in flight, or held behind one) or `error`. Sending never clears the answer (`clearAnswerOn` still does). A failure replaces the answer with the action's `failure` tree plus a `liveCallRetry` button and lasts until the next change or that button — nothing is retried automatically.

**Footer press.** A `button` is disabled only by its `enabled` (with `disabledText`). Pressed, its record is judged against the called action's `inputModel`: invalid sends nothing and puts the findings on the fields until a field changes; valid flushes the live writes and waits for them, and is not sent if one fails.

**Leaving.** An `Ui.ActionForm` holds the existing leave guard, with `confirm` behaviour and no `unsaved` key, while a write's record differs from its baseline — sendable or not — or a request is in flight (a failure clears the baseline, so a failed write counts); one with only `latest` calls or footer buttons never does. A move within the application, to another page or path, first sends a waiting or held write and waits for it, the history step undone meanwhile; accepted, the move proceeds with no question; failed, the existing unsaved question is asked, and a second attempt while waiting asks at once. A move changing only the query or fragment keeps the form. Closing or reloading raises the browser's own prompt. A `latest` request is aborted on leave; nothing is sent with `keepalive`.

**Autosave only replaces.** A pressed `POST` action creates the draft and navigates to the editor's address built from `result.id`; the editor reads the draft with a `Ui.Data`, whose content places an `Ui.ActionForm` with `initialValues` over `data`, a `PUT` live call whose `inputModel` is loose, and a `footer` Publish whose action's `inputModel` is strict. A create is not idempotent and a live write is coalesced, so a live call never creates; writing the created key back into hidden values was rejected as a mutable binding on a non-idempotent first write. Two tabs editing one draft: the last write wins — the record contract has no conditional write.

## Example

The shell is one application serving both screens: the preview of issue #822 and a draft editor. Before, the preview page's content is a pressed action:

```yaml
- type: composite
  ref:
    kind: Ui.Action
    inputModel: !ref PreviewRequest
    fields: [!ref periodField, columns, showChart]
    request: { target: /api/preview }
    label: Show
```

After:

```yaml
kind: Telo.Application
metadata: { name: LiveForms }
requires: { telo: ">=unreleased" }
lang: en
imports:
  Http: ../../modules/http-server
  Ui: ../../modules/ui
  UiReact: ../../modules/ui-react
ports: { http: { env: PORT, protocol: tcp, default: 8160 } }
targets:
  - !ref server
  - { invoke: { kind: Telo.OpenUrl }, inputs: { url: !interpolate "http://localhost:${{ ports.http }}/preview" } }
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
kind: Ui.DateRangeField
metadata: { name: periodField }
property: period
presets: [{ label: This month, unit: month, offset: 0 }, { label: Previous month, unit: month, offset: -1 }]
initialPreset: This month
---
kind: Http.Api
metadata: { name: api }
routes:
  - request: { method: POST, path: /preview }
    handler: { kind: Telo.Value, value: { items: [{ name: Ada, hours: 12 }, { name: Grace, hours: 9 }] } }
    returns: [{ status: 200, content: { application/json: { body: {} } } }]
  - request: { method: POST, path: /generate }
    handler: { kind: Telo.Value, value: {} }
    returns: [{ status: 200, content: { application/json: { body: {} } } }]
  - request: { method: POST, path: /posts }
    handler: { kind: Telo.Value, value: { id: "1" } }
    returns: [{ status: 200, content: { application/json: { body: {} } } }]
  - request: { method: GET, path: "/posts/{id}" }
    handler: { kind: Telo.Value, value: { title: First post, body: Hello } }
    returns: [{ status: 200, content: { application/json: { body: {} } } }]
  - request: { method: PUT, path: "/posts/{id}" }
    handler: { kind: Telo.Value, value: {} }
    returns: [{ status: 200, content: { application/json: { body: {} } } }]
  - request: { method: POST, path: "/posts/{id}/publish" }
    handler: { kind: Telo.Value, value: {} }
    returns: [{ status: 200, content: { application/json: { body: {} } } }]
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
                kind: Ui.ActionForm
                model: !ref PreviewRequest
                fields:
                  - !ref periodField
                  - { kind: Ui.InputField, property: columns, control: options }
                  - { kind: Ui.InputField, property: showChart, control: toggle }
                liveCalls:
                  - action:
                      kind: Ui.Action
                      inputModel: !ref PreviewRequest
                      fields: [!ref periodField, columns, showChart]
                      outputModel:
                        kind: Telo.JsonSchema
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
                      request: { target: /api/preview }
                      label: Preview
                      concurrency: latest
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
                                  required: [name, columns]
                                  properties: { name: { type: string }, columns: { type: string, enum: [short, full] } }
                              request: { target: /api/generate }
                              label: Generate
                            inputs: { name: !cel "row.name", columns: !cel "input.columns" }
                    inputs: { period: !cel "values.period", columns: !cel "values.columns", showChart: !cel "values.showChart" }
        - kind: Ui.Page
          path: /posts/new
          title: New post
          children:
            - type: composite
              ref:
                kind: Ui.Action
                inputModel: { kind: Telo.JsonSchema, schema: { type: object, additionalProperties: false, properties: {} } }
                outputModel: { kind: Telo.JsonSchema, schema: { type: object, required: [id], properties: { id: { type: string } } } }
                request: { target: /api/posts }
                label: Start a draft
                onSuccess: { navigate: { path: "/posts/{id}", pathParams: { id: !cel "result.id" } } }
        - kind: Ui.Page
          path: /posts/{id}
          title: Edit post
          children:
            - type: composite
              ref:
                kind: Ui.Data
                model: !ref DraftModel
                source: { path: "/api/posts/{id}", pathParams: { id: !cel "params.id" } }
                content:
                  type: composite
                  ref:
                    kind: Ui.ActionForm
                    model: !ref DraftModel
                    initialValues: !cel "data"
                    liveCalls:
                      - action:
                          kind: Ui.Action
                          inputModel:
                            kind: Telo.JsonSchema
                            schema:
                              type: object
                              required: [id]
                              properties: { id: { type: string }, title: { type: string }, body: { type: string } }
                          request: { method: PUT, target: { path: "/api/posts/{id}", pathParams: { id: !cel "input.id" } } }
                          label: Draft
                          concurrency: serial
                        inputs: { id: !cel "params.id", title: !cel "values.title", body: !cel "values.body" }
                        debounce: 1s
                    footer:
                      - type: button
                        action:
                          kind: Ui.Action
                          inputModel:
                            kind: Telo.JsonSchema
                            schema:
                              type: object
                              required: [id, title, body]
                              properties: { id: { type: string }, title: { type: string, minLength: 1 }, body: { type: string, minLength: 1 } }
                          request: { target: { path: "/api/posts/{id}/publish", pathParams: { id: !cel "input.id" } } }
                          label: Publish
                        inputs: { id: !cel "params.id", title: !cel "values.title", body: !cel "values.body" }
```

Two refused edits, each fails `telo check`. Pointing the draft live call's action at a `POST` with no `latest` — `request: { target: /api/posts }`, `concurrency: serial` — reports:

```
$ telo check ./telo.yaml
error UI_LIVE_CALL_UNSAFE: liveCalls[0] runs an action that sends a POST without `concurrency: latest`, which would run at every pause. Use a PUT, or `latest` for a read.
```

and giving the draft `PUT` action `concurrency: latest` reports:

```
$ telo check ./telo.yaml
error UI_ACTION_LATEST_UNSAFE: concurrency `latest` aborts a pending request, which would reorder this `PUT`. Use `serial`.
```

## Verify

- A preview that starts valid sends exactly one request at load; the draft editor sends none.
- Three quick presses of a `latest` Show abort two requests and draw only the third answer; the answer of an aborted request is never drawn.
- Typing in a text field sends once after the pause; a toggle or Enter sends at once; hiding the tab sends a waiting `PUT`; the existing `apply: typing` filter tests pass unchanged on the shared rule.
- An edit valid for the form's `model` but invalid for the action's `inputModel` puts the finding on the bound field, sends nothing and keeps the answer; an invalid record at start draws no loading indicator.
- Two edits during an in-flight `PUT` produce exactly one more `PUT` with the newest values, under `parallel` and under `serial`; after a no-answer failure, changing a value and back re-sends it.
- A 503 on the draft `PUT` draws the failure and the retry button and sends nothing more until a change or the button; no timer is pending.
- A live call whose action declares `onSuccess.navigate` answers 2xx and the location is unchanged; the same action pressed from a footer `button` navigates.
- Pressing Start a draft makes one `POST` and lands on `/posts/1` with no `PUT`; an edit the draft `PUT`'s `inputModel` refuses sends nothing, and closing the page asks.
- Typing then clicking a link within the pause produces one `PUT` and the page moves with no question; with the server answering 500 the same click asks; a second click while waiting asks at once; a query-only move asks nothing; reloading with a waiting write shows the browser's prompt.
- Publish with an empty `title`: nothing is sent, the finding is on the field, the button stays enabled, typing a title clears it.
- A live call that omits `debounce` carries `300`, `debounce: 1s` carries `1000`, on the wire.
- Each rule is pinned both ways in `modules/ui/tests/` — refused in the declaring library, failing a consumer's run with its `ERR_` twin; a `modules/ui` unit test fails when a restated field rule differs across `Ui.Form`, `Ui.Action` and `Ui.ActionForm`.

## Decisions

- **The trigger belongs to the call site, the effect to the operation.** Rejected: a `submit.on: change` key on `Ui.Action` (a button pressing itself; its own form would call itself, a cycle), an `Ui.Form` key (`presentation` is a collection write; making it optional would be a discriminator), a `form` node (field judgements are resource and referrer rules, which a node would repeat in every region).
- **`latest` is the one safety fact, on the action.** Safety cannot be derived from a method the analyzer cannot see behind; on the call it would let one effectful operation be superseded from one place. A `GET` on `Ui.Action` was rejected: a read is a `Ui.Data`, and the issue's route is a `POST`.
- **A live call is sent by an edit only.** Re-sending on an announcement would make a `latest` preview re-send itself at every answer, and fixing that would need origin tracking or a second rule; a preview stale after another action's write is the staleness any answer has.
- **No automatic retry, no `keepalive`.** A stuck server would block navigation and every tab would retry; the next change or the retry button is the retry, and the leave question covers a write not accepted.

## Bookkeeping

Run `telo release floor` with the change (only `ui`'s own kinds widen, so no hand-written floor). Docs (`action-form.md`, `action.md` §Pressing, `surfaces.md` §unsaved input, `filters.md`, `field-kinds.md`, `texts.md` and the translations, the renderer's `parts.json`, default theme, `ui-react-radix` and the `CheckTheme` scenes); the Declarative UI paragraph of `modules/CLAUDE.md`; the authoring-agent primer and the hub `build-ui` guide; a benefits-ledger entry "Live preview and autosave" under Standard library; `Added` fragments for `ui`, `ui-react` and, where parts or scenes change, `ui-react-radix` and `ui-react-conformance`.
