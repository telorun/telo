# Ui.Form

A form over a data model. It lives on a [page](page.md), placed among its nodes
like any composite: the page reached by its own address is a full page, and
opened from a [press](presses.md) it is drawn in the press's
[surface](surfaces.md).

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of the record the form holds and enters |
| `record` | | the collection record the form writes: [`{ presentation, key? }`](#what-it-edits); excludes `onSubmit` and `autosave` |
| `onSubmit` | | the [write run when the form is submitted](#onsubmit); excludes `record` |
| `autosave` | | the [write sent as the values settle](#autosave); excludes `record` |
| `onSuccess` | none | [effects](#onsuccess) run after the submit write succeeds; needs `record` or `onSubmit` |
| `onFailure` | none | [effects](#onfailure) run after the submit write does not succeed; needs `record` or `onSubmit` |
| `clearAnswerOn` | none | [properties whose change clears](#clearansweron) what the writes drew of their last answers |
| `initialValues` | the address and store, then the model's defaults | the record the form [starts from](#what-it-starts-from): a plain chain over the roots where the form is placed |
| `unsaved` | `confirm` | [whether leaving with unsaved input asks first](#the-form-owns-its-lifecycle): `confirm` or `discard` |
| `afterSubmit` | `close` | [what the form does once the record is saved](#the-form-owns-its-lifecycle): `close`, `keep` or `again`; needs `record` or `onSubmit` |
| `fields` | every enterable property | the fields, top to bottom: a property name, or a [field kind](field-kinds.md) |
| `groups` | none | labelled sections the fields name by `group` ([field kinds](field-kinds.md#groups)) |
| `state` | not kept | where the values entered are kept between visits ([kept values](field-kinds.md#kept-values)) |

```yaml
kind: Ui.Form
metadata: { name: taskForm }
model: !ref TaskInput
record: { presentation: !ref tasksPresentation, key: !cel "data.id" }
initialValues: !cel "data"
```

## Three kinds of form

A form is exactly one of three, decided by which write keys it holds:

| Kind | Holds | Its write |
| --- | --- | --- |
| **Record editor** | `record` | the default write to the collection, `POST` or merge-`PATCH`, judged against the collection's write shapes (`UI_WRITE_*`) |
| **Mutation form** | `onSubmit` and/or `autosave` | the called [mutation](mutation.md), pressed and/or as the values settle |
| **Free-standing** | neither | none: the values are only read |

`record` beside `onSubmit` or `autosave` is `SCHEMA_VIOLATION`: beside a
mutation, `record`'s key, baseline and validator would describe a write that is
never made. So are `onSuccess` and `afterSubmit` on a form with neither `record`
nor `onSubmit`, since nothing is submitted for them to follow. The same rules
hold from `telo check` and the kernel.

Without `record` the form has no collection: no default write, and no relation
pickers — a relation is entered by an explicit
[`Ui.PickerField`](field-kinds.md#uipickerfield) over a `Ui.CollectionOptions`,
and a bare relation property is `UI_FIELD_UNSUPPORTED`. A form with neither
`record` nor `onSubmit` shows no submit button; with no `autosave` either it is
legal, and its values are read by its own `shown` conditions, by forms sharing
its `state.key`, and by every query or listing that [names it](#a-query-that-follows-a-form).

A property name is exactly `{ kind: Ui.InputField, property: <name> }`: the
page document is the same for both spellings. A field's label is the
property's `title`, else its name.

## Related records

A property whose relation the presentation presents is entered with a
[picker](field-kinds.md#uipickerfield) of the related records — searched with
the relation's `search`, labelled with its `label` and `hint`, linked with its
`to` — whether it is named bare in `fields` or `fields` is left out, so a
post form shows an author picker with nothing written beyond the relation. A
field kind written for the property wins.

## Fields drawn on a condition

A field's `shown` is a [condition](conditions.md) over `values` — the record
the form holds now, typed from `model` and read only by a condition:

```yaml
fields:
  - kind
  - kind: Ui.InputField
    property: detail
    shown: { at: !cel "values.kind", matches: { const: other } }
```

A hidden field keeps what it holds, and its value is neither sent nor checked.
The record is still held to the model: a property the model requires whose
field is hidden blocks the submission, with the finding shown under the form.
`values.x` outside a form is refused by `telo check`.

## What a form can enter

A control enters one plain value or a list of them. A property is enterable
when it is:

- a **scalar** — typed `string`, `number`, `integer` or `boolean` (`null`
  beside it is set aside), or declaring an `enum`; or
- a **list of scalars** — typed `array` with an `items` that is one.

An object, a list of objects and a list with no `items` are not: with `fields`
left out they get no field, and the form sends nothing for them. A field kind
may enter one anyway — a [date range](field-kinds.md#uidaterangefield) enters
an object. A [`Ui.Prompt`](mutation.md#asking-first) reads the same definition, and an
input field's `auto` control fits exactly what a property name can enter.

## What it edits

`record.presentation` names the collection written to — its source's `basePath`
is where, its relations how related records are offered. `record.key` says
which stored record the form edits: a plain chain to that record's key value,
over the roots where the form is placed — `data.id` inside a query node,
`params.id` on a page whose path variable is the key. Its type is held to the
collection's key property: `params.id` is a string, so over a collection keyed
by an integer it is `CEL_TYPE_ERROR`, and a literal of another type is
`SCHEMA_VIOLATION`. The roots are the ones a destination reads
(`row`, `data`, `query`, `params`, `values`, `result`, `input`), each in scope
only where the place binds it: one that is not is `CEL_UNKNOWN_IDENTIFIER`.

| `record.key` | Request |
| --- | --- |
| written | `PATCH <basePath>/<key value>` with `content-type: application/merge-patch+json` |
| omitted | `POST <basePath>` |

Either write announces `<basePath>` and `<basePath>/<key value>`, so the
listing and the reads of that record read again. The collection answers `POST`
with the stored record (a 2xx valid against its `model`, as `PATCH` does), which
is `result` for the form's [`onSuccess`](#onsuccess); a 2xx body the `model`
refuses is a failure (`ERR_UI_RESPONSE_INVALID`). The key is explicit: a form
that inferred "the record I was started from" would write wherever its query
happened to read.

**The collection's write shapes.** A form is checked against the shape its
write is held to — `schemas.create` without `record.key`, `schemas.update` with
it:

| Rule (`RESOURCE_RULE_VIOLATED`, `REFERRER_RULE_VIOLATED` for the update shape, in `data.rule`) | When |
| --- | --- |
| `UI_WRITE_UNDECLARED` | the collection declares no shape for the write the form makes |
| `UI_WRITE_SHAPE_MISMATCH` | a property of `model` the shape does not declare, or declares with another type |

Both are refused again when the form is first read (`ERR_UI_WRITE_UNDECLARED`,
`ERR_UI_WRITE_SHAPE_MISMATCH`), for a manifest that never passed `telo check`.

## What it starts from

An edit page reads the record with a [`query`](query.md) node at the item's
address and places the form among its children with `initialValues` over
`data`; the query's `ETag` is the validator the form's `PATCH` carries.

```yaml
children:
  - type: query
    query: { kind: Ui.Query, model: !ref Task, url: { path: "/api/tasks/{id}", pathParams: { id: !cel "params.id" } } }
    content:
      - type: composite
        ref:
          kind: Ui.Form
          model: !ref TaskInput
          record: { presentation: !ref tasksPresentation, key: !cel "data.id" }
          initialValues: !cel "data"
```

A form starts from `initialValues` when it is drawn, and the address and its
`state` store are read only where `initialValues` is absent. It starts again,
the unsaved-input question asked first, when the resolved address of the query
its `initialValues` reads changes; a re-read at the same address keeps the form
and what was typed. `initialValues` is held to fit `model`.

## The form owns its lifecycle

`unsaved` and `afterSubmit` are the form's, so the same form behaves alike in a
surface and on a page of its own.

- `unsaved: confirm` asks before unsaved input is dropped by anything that
  closes the form — its surface closing, a move to another page, another record
  opening in the same surface — and `discard` drops it
  ([the guard](surfaces.md#after-a-submit-and-unsaved-input)).
- `afterSubmit: close` closes the surface the form's page is open in, and on a page of its own the
  form stays, saved. `keep` leaves it open with its values; `again` returns it
  to the values it started from — on a create page a fresh record, on an edit
  page the saved one.

The listing reloads after every submit. `afterSubmit` applies after the write's
`result` is drawn and before the [`onSuccess` effects](#onsuccess).

## What it sends

- **Creating** (no `record.key`), the record holds each field that has a value. A field left
  empty is left out of it.
- **Editing** (`record.key`), the form starts from `initialValues`. What it sends is the merge
  patch (RFC 7396) of the shown properties whose value differs from that
  record: the entered value for one that changed, `null` for one emptied, and
  for an object only the members that changed (a removed one as `null`); a list
  is sent whole. A property the form does not show, or did not change, is not named, so a form
  over a narrower model than the record leaves every other column as it is, and
  a form that changed nothing sends `{}`, which the collection answers with the
  stored record. The patch and the `If-Match` it carries are pinned by
  `conformance/merge-patch.json`.
- The `ETag` of the last read or write at the item's path, when the server sent
  one, is sent back as `If-Match`
  ([preconditions](mutation-contract.md#preconditions)). When another save came
  first the collection answers `412`: the form shows the problem's `code`
  (`ERR_UI_PRECONDITION_FAILED` without one), keeps every value entered, reads
  the record again for its new validator, and pressing save again sends the
  same changes against the current record.
- A record that fails the mutation's `inputModel` before a write is sent draws
  the write's `failure` with `code: ERR_UI_MUTATION_INPUT_INVALID` (read as
  `error.code`), and nothing is sent.
- A checkbox always has a value: `true` or `false`.
- A list with nothing chosen or typed is left out, like an empty field.
- A required field left empty is refused in the page, on the field, and
  nothing is sent.

## `onSubmit`

`onSubmit` runs a [mutation](mutation.md) when the form is submitted, in place
of a collection write:

| Field | | |
| --- | --- | --- |
| `mutation` | required | the write run: a `!ref`, or one inline |
| `inputs` | required | what the mutation receives, by input property, read over `values`, `params` and `query` |
| `label` | `save` | the submit button's accessible name; omitted, `ui`'s `save` text |
| `confirm` | | a question asked before the write is sent |
| `enabled` | always | when the button can be pressed, over `values`, and why not |
| `result` | nothing drawn | a node tree drawn of a success beneath the fields, over `result`, `input` and `values` |
| `failure` | the error's code and message | a node tree drawn beneath the fields when the write does not succeed, over `error`, `input` and `values` |

There is no `prompt` — the form enters the fields — and no `onSuccess`, which is
the [form's](#onsuccess), since a form makes one submit write.

`values` at `inputs` is the record the form holds now, typed from `model`.
`required` never changes a type, so `values.title` of an optional property is a
string; whether it is present is judged at run time against the mutation's
`inputModel`. An input reading a property whose field is hidden or empty reads
nothing and is left out of the record sent. `inputs` is judged statically
against `inputModel` as a call's is: a binding it does not take, or a required
input left out, is `CONTRACT_INPUTS_MISMATCH`.

Pressed, the record is judged against the mutation's `inputModel`: invalid sends
nothing and puts the [findings](#findings) on the fields until a field changes,
with the button staying enabled. Valid, the form
[flushes its `autosave`](#flush-before-submit) first, then sends the write.

```yaml
kind: Ui.Form
model: !ref DraftModel
onSubmit:
  mutation:
    kind: Ui.Mutation
    inputModel: !ref PublishRequest
    url: { path: "/api/posts/{id}/publish", pathParams: { id: !cel "input.id" } }
  inputs: { id: !cel "params.id", title: !cel "values.title", body: !cel "values.body" }
  label: Publish
  confirm: Publish this post?
onSuccess:
  - { kind: Ui.Navigate, href: /posts/new }
```

## `onSuccess`

`onSuccess` is a list of [effects](mutation.md#after-a-success) run after the
form's submit write succeeds — the default write of a record editor, or
`onSubmit`'s mutation — over `values` (typed from `model`) and `result`:

- after `onSubmit`, `result` is the mutation's answer, typed from its
  `outputModel` (closed and empty when it declares none);
- after the default write, `result` is the stored record the collection answered
  with, typed from the collection's `model`.

So a create page goes to what it created:

```yaml
onSuccess:
  - { kind: Ui.Navigate, href: { path: "/people/{id}", pathParams: { id: !cel "result.id" } } }
```

`result.titel` there is `CEL_UNKNOWN_FIELD`. An `autosave` has no effects: it
never navigates.

**The order after a submit.** When the submit write succeeds: the write's
`result` tree is drawn, then the form's `afterSubmit` applies (`close`, `keep`
or `again`), then the `onSuccess` effects run in order. Opened in a drawer with
`afterSubmit: close` and a `Ui.Navigate`, the drawer closes and then the
location changes.

**What is announced.** After `onSubmit` only the mutation's own announcement
([`url` and `invalidates`](mutation.md#invalidation)) is made. After the default
write, `<basePath>` and `<basePath>/<key value>` are announced. After an
`autosave` write the mutation's `url` and `invalidates`, once per acknowledged
save, so a query reading the saved record reads again — and keeps the form and
what was typed since (the [form starts again](#what-it-starts-from) only when
the address it reads changes).

## `onFailure`

`onFailure` is a list of [effects](mutation.md#after-a-success) run when the
form's submit write does not succeed, over `values` (typed from `model`) and
`error` (a [`Ui.RequestError`](conditions.md)). It follows the write's `failure`
tree, which stays drawn: a toast there adds to it, never replaces it.

```yaml
onFailure:
  - kind: Ui.Toast
    text: { text: "Could not create {$name}: {$message}", values: { name: !cel "values.name", message: !cel "error.message" } }
```

`result` is not in scope: `result.name` there is `CEL_UNKNOWN_IDENTIFIER`. It
runs only when a submit write was sent and did not succeed, so an `autosave`
failure runs none. Like `onSuccess` it needs `record` or `onSubmit` — under
`onSubmit` or `record` themselves it is `SCHEMA_VIOLATION`. The effects are
[toasts](toasts.md) and the other effect kinds.

## `autosave`

`autosave` saves the record as it is edited:

| Field | | |
| --- | --- | --- |
| `mutation` | required | the write sent: a `!ref`, or one inline |
| `inputs` | required | what the mutation receives, read over `values`, `params` and `query` as `onSubmit`'s |
| `debounce` | `300ms` | how long typing must pause before the record is sent: a `Telo.Duration` of at least `0s` |
| `result` | nothing drawn | drawn beneath the fields of a success, over `result`, `input` and `values` |
| `failure` | the error's code and message | drawn beneath the fields when the write does not succeed, with a retry button, over `error`, `input` and `values` |

Autosave is never pressed, so it has no `label`, `confirm`, `enabled` or
`onSuccess`.

**It must replace.** Changes are coalesced and a failed write is sent again, so
the mutation must be idempotent: a `PUT`, or a `PATCH` sending the whole draft.
A mutation whose `method` is `POST`, written or by default, is
`UI_FORM_AUTOSAVE_NOT_IDEMPOTENT` (`ERR_UI_FORM_AUTOSAVE_NOT_IDEMPOTENT` at
creation, which also covers a mutation reached through a library input).
Creating a record belongs to a pressed call: a `POST` mutation run from a
[`button`](nodes.md#buttons) creates the draft, and the editor autosaves it.

**When a write is sent.** A record is sent when it is valid against the
mutation's `inputModel`, differs from the baseline and is not the record already
in flight.

- **Baseline.** The newest record the server acknowledged; the form's starting
  record at first, so nothing is sent at start. A failure clears it, since the
  outcome is unknown, so after a failure any valid record — a reverted one
  included — is sent.
- **Send.** A choice or a commit sends at once, typed text after `debounce`, and
  the page becoming hidden sends a waiting write.
- **Hold and coalesce.** A change made while a write is in flight is held, the
  newest replacing older, and sent when that write answers, whether it succeeded
  or failed; a change to a record that cannot be sent drops what was held. A
  write is never aborted and never reordered. Under a `serial` mutation a write
  also waits its turn in the mutation's page-wide queue behind other calls of
  it, taking every change made meanwhile and going once; the coalescing is the
  same under `parallel`.
- **Failure.** A failed write replaces the answer with the `failure` tree plus a
  retry button, and lasts until the next change or that button — nothing is
  retried automatically.

The form's `data-state` is `submitting` while a write is in flight or held,
`error` after a failure until the next change or retry, else `idle`. Beneath the
fields, while an autosave write is awaited the answer stays, `aria-busy` is set
on the answer region and the `saving` text is drawn beside it; the retry button
is the `retry` text. Both are `ui`'s own [keyed texts](texts.md#uis-own-texts),
translated like the rest and overridden by a `Ui.Translations` of your own.

The rules are pinned by `conformance/form-writes.json`.

### Unsaved

A form with `autosave` is unsaved, for its [`unsaved` guard](surfaces.md#after-a-submit-and-unsaved-input),
while its record differs from its baseline — sendable or not — or a write is
waiting or in flight, or the last write failed and none has been acknowledged
since. With `unsaved: confirm`, a move that closes the form asks: **keep
editing** leaves the waiting write to send as scheduled, **discard** drops it,
and a write in flight is not aborted. Nothing is sent with `keepalive`, so a
stuck server never blocks navigation. A form with no write is never unsaved.

## Flush before submit

A valid submit first sends any waiting `autosave` write and waits for the
writes in flight; the submit is not sent when one fails. So Publish always acts
on what was last typed, and never races the draft's own save.

## Findings

Each write's record is judged against its mutation's `inputModel` as values are
entered. An invalid one sends nothing and says why: a finding lands on the field
a bound input names as exactly `values.<property>` (`title: !cel "values.title"`
puts a `title` finding on the `title` field), by the form's touched-field rule;
any other finding is drawn in that write's answer region beneath the fields. A
field shows the form's `model` findings first, then each write's, identical
wording once. A 400's `data.issues` land by the same rule.

## What is drawn

Beneath the fields, `onSubmit`'s and `autosave`'s answer regions draw their
`result` and `failure` trees in the `mutation-result` and `mutation-failure`
[parts](https://hub.telo.run/module/oci/ghcr.io/telorun/ui-react/); each is cleared when its write starts,
and by [`clearAnswerOn`](#clearansweron).

## `clearAnswerOn`

`clearAnswerOn` lists form properties; a change to one of them clears both
writes' answers, so a stale "Published" does not outlive the title it was about.
A new write always clears them. A property the form's `model` does not declare is
`UI_FORM_CLEAR_UNKNOWN_PROPERTY`.

## A query that follows a form

A form is placed where the page wants it, and what it enters can drive reads
placed anywhere else, as an HTML `<input form="…">` or `<output for="…">` names
a form elsewhere in the document. A [`Ui.Query`](query.md#following-a-form) or a
[`Ui.Listing`](listing.md#following-a-form) names it with `form: !ref <form>`;
the `form` root then reads the form's record in that query's `url` and
`input.body`, in the trees of every `query` node drawing it, and in a listing's
`filters` and row actions. The form's `model` types it, so `form.perod` is
`CEL_UNKNOWN_FIELD`.

```yaml
- type: columns
  children:
    - { type: composite, ref: !ref previewForm }
    - type: query
      query:
        kind: Ui.Query
        form: !ref previewForm
        model: !ref PreviewAnswer
        url: /api/preview
        input:
          model: !ref PreviewRequest
          body: { period: !cel "form.period", columns: !cel "form.columns" }
      content:
        - { type: list, rows: !cel "data.items", columns: [{ header: Name, value: !cel "row.name" }] }
```

`form` is the form's record once it has **settled** (the [settle rule](https://hub.telo.run/module/oci/ghcr.io/telorun/ui-react/))
and is valid against its `model`:

- **Validity.** While the entered record is invalid, `form` keeps the last valid
  record and the fields show their findings. Until the form first holds a valid
  record `form` holds nothing, and a query whose `url` or `input.body` reads it
  is not sent at all and draws nothing — not even its `loading` tree — as for a
  `url` that holds nothing.
- **Reading.** The query reads when the form first holds a valid record and
  again when the request its `url` and `input.body` resolve to changes: at most
  one read in flight, an answer to an earlier request never drawn, the drawn
  answer kept while the next is awaited. No press, no debounce key.
- **Where the form is not drawn.** A query whose form is not on the page being
  drawn reads nothing and its nodes draw nothing.

A form read where its query names none is `CEL_UNKNOWN_IDENTIFIER` ("'form' is
not available here: the query names no form in `form`"), and `form` naming
anything but a `Ui.Form` is `REFERENCE_KIND_MISMATCH`.

**Two placements share one record.** A form placed twice on one page is one
record: both placements show and edit the same values, as two filter bars
sharing a `state.key` share their state. The renderer keeps the settled record
per form and page — the page and each page opened over it keep their own — for
as long as that page is drawn. A form that starts again (its `initialValues`
read at another address) discards its settled record, so `form` holds nothing
until the form is valid again.

## The draft editor

A page that saves a draft as it is typed and publishes it on request:

1. A pressed `POST` call — a [`button`](nodes.md#buttons) over a mutation whose
   `outputModel` holds `id` — creates the draft, and its `onSuccess` goes to the
   editor's address built from `result.id`.
2. The editor reads the draft with a [`query`](query.md) node, whose content
   places a `Ui.Form` with `initialValues: !cel "data"`, a `PUT` `autosave` whose
   mutation's `inputModel` is loose (a title may be empty while drafting) and an
   `onSubmit` Publish whose mutation's `inputModel` is strict.
3. Each save announces its own url — the address the editor's query reads — so
   the query reads again after every save; the re-read keeps the form and what
   was typed since.

A mutation call carries no `If-Match`, so with two tabs editing one draft the
last write wins. Publishing with an empty title sends nothing: the finding is on
the field and typing a title clears it.

## How a control is derived

An input field's `control` names one ([field kinds](field-kinds.md#uiinputfield));
`auto`, and a property name, derive it from the model property, in this order:

| Property | Control |
| --- | --- |
| `type` includes `boolean` | checkbox |
| declares `enum` | select |
| `type` includes `number` or `integer` | number input |
| `format: date` / `date-time` / `time` | date, date-and-time, time input |
| string with `contentMediaType` beginning `text/` | multi-line text |
| any other string | single-line text |

A list is entered as a whole, by what its `items` are:

| `items` | Control |
| --- | --- |
| declares `enum` | a multi-choice group, one option per value |
| any other scalar | typed tags: each entry is one item, read as the item's type |

There is no length heuristic: a long string is single-line unless the model
says it is a document.

## Validation

The node a form provides carries the model's JSON Schema, and the renderer
checks the record against it before sending — by interpreting the schema, with
no generated code. It reads the [interpreted profile](conditions.md#the-interpreted-profile) —
`type`, `const`, `enum`, `not`, `allOf`, `anyOf`, `required`, `properties`,
`items`, `minItems`, `maxItems`, `uniqueItems`, `minLength`, `maxLength`,
`pattern`, the numeric bounds and `multipleOf` — the same keywords a condition
is written in, so a form and a condition cannot disagree about one. Every
other keyword — a `pattern` outside `re2-pattern` included — stays legal and is
left to the API. A field's findings are shown as values are entered, once the
field has been touched, and every field's on a submission.
A 400's `data.issues` are shown on the fields: an issue whose `pointer`'s first
segment after `/body` is a shown field's property — `/body/period/from`
reaches the field entering `period` — marks that field until it changes again,
worded by its `keyword` and `params` as the browser's own validation words that
keyword ([`ui`'s own texts](texts.md#uis-own-texts)), so a refusal the API
finds reads like one the browser finds. Every other issue is shown under the
form as its path and that text; a 400 with no issues shows its `detail`.

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_FIELD_UNKNOWN_PROPERTY` | a field names a property the model does not declare |
| `UI_FIELD_UNSUPPORTED` | a property name names a property no control can enter: an object, or a list of anything but scalars |
| `UI_FIELD_REQUIRED_NOT_ENTERED` | a property the model requires has no field |
| `UI_FIELD_DUPLICATE` | two fields enter one property |
| `UI_FIELD_GROUP_UNKNOWN` | a field names a group `groups` does not declare |
| `UI_FIELD_GROUP_SPLIT` | a group's fields are not listed one after another |
| `UI_FIELD_GROUP_DUPLICATE` | two groups share a name |
| `UI_STATE_FIELD_UNKNOWN` | `state.fields` names a property no field shows |
| `UI_WRITE_UNDECLARED`, `UI_WRITE_SHAPE_MISMATCH` | [the collection's write shapes](#what-it-edits) |
| `UI_FORM_AUTOSAVE_NOT_IDEMPOTENT` | `autosave` over a mutation whose `method` is `POST`, written or by default |
| `UI_FORM_CLEAR_UNKNOWN_PROPERTY` | `clearAnswerOn` names a property `model` does not declare |

What a field kind refuses of its own fit is its kind's rule, reported at the
field's place in `fields` ([field kinds](field-kinds.md#refused)). The form
refuses the same things itself when it is first read (`ERR_<code>`), asking
each field kind for its own answer, for a manifest that never passed
`telo check`.

## What a renderer receives

A `form` node carries its `id` (the declaration's identity, under which the
settled record of every placement is kept), `schema`, `record` (`{ basePath,
key, answer }` — `answer` the collection's model the stored record is held to —
or `null`), `initialValues`, `unsaved`, `afterSubmit`, `fields`, `groups`,
`state`, `onSuccess` and `onFailure` (effect specs, `[]` when none) and
`clearAnswerOn`. Its
`onSubmit` is `{ mutation, inputs, label, confirm?, enabled?, result?, failure }`
and its `autosave` `{ mutation, inputs, debounce, result?, failure }`, each
`null` when absent, `debounce` in integer milliseconds (`300` by default,
`debounce: 1s` is `1000`). The mutation is a
[`Ui.MutationSpec`](mutation.md#what-a-renderer-receives). A query spec and a
`listing` node carry the id of the form they name as `form`, `null` when none.
