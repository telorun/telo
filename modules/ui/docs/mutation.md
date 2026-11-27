# Ui.Mutation

A write a page declares once: the record it takes, the shape of a success's
answer, the request it sends and the reads it invalidates. It draws nothing —
no fields, no button, no answer trees — so it is the same write wherever it is
run: from a [form](form.md), a button, a row, a markdown annotation or a
layout's `move`. What a person presses, what follows a success and what is drawn
of the answer belong to the place that runs it, a [call](#calls).

| Field | | |
| --- | --- | --- |
| `inputModel` | required | the shape of the record sent: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `outputModel` | | the shape of a success's body, read as `result`; a body is held to it |
| `method` | `POST` | `POST`, `PUT`, `PATCH` or `DELETE`; a read is a [`Ui.Query`](query.md) |
| `url` | required | a [request target](nodes.md#addresses) over `input` |
| `invalidates` | none | the request targets announced after a success, each a [`Ui.InvalidationTarget`](#invalidation) over `input` and `result` |
| `concurrency` | `parallel` | `parallel` or `serial`: whether the calls of this mutation run at once or one after another across the page |

The route it reaches must speak [the mutation contract](mutation-contract.md):
one `<method> <url>` request, its JSON body the input minus what the url reads,
answered with a JSON object on success and a problem body (`code`, `detail`, a
400's `data.issues`) otherwise.

```yaml
kind: Ui.Mutation
metadata: { name: generateReports }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
url: /api/reports
invalidates: [/api/reports]
```

A mutation used once is declared in place where it is run, with no
`metadata.name`; one used by several places is named and referenced with `!ref`.

## The request

`url` is a [`Ui.RequestTarget`](nodes.md#addresses): an app-relative path, or
`{ path, pathParams, queryParams }` whose bindings read `input`, the record a
call sends. An input property is **consumed** when a `pathParams` or
`queryParams` binding is exactly the chain `input.<property>`; a deeper chain
(`input.range.from`) reads without consuming, and a literal consumes nothing. A
consumed property travels in the url and is left out of the body.

```yaml
kind: Ui.Mutation
inputModel: !ref ConversationRename   # { id, title }
method: PATCH
url: { path: "/api/chat/conversations/{id}", pathParams: { id: !cel "input.id" } }
```

sends `PATCH /api/chat/conversations/<id>` with the body `{ "title": … }`.

| Method | Body |
| --- | --- |
| `POST`, `PUT`, `PATCH` | the input's properties that hold a value, minus the consumed ones |
| `DELETE` | none; every input property must be consumed (`UI_MUTATION_INPUT_UNSENT`) |

A url whose parameter holds nothing is not sent (`ERR_UI_ADDRESS_UNRESOLVED` as
a failure, naming the parameter). A `GET`, an absolute url and a page reference
are refused.

## Invalidation

After a 2xx the resolved `url` path and each resolved `invalidates` path are
announced as changed; a listing's call announces its `basePath` too. A
[`Ui.Query`](query.md), [`Ui.Listing`](listing.md) or [`Ui.Chat`](chat.md) whose
request path equals an announced one — resolved, encoded and app-relative, the
query left out — reads again. `invalidates` entries are request targets over
`input` and `result`, except that a whole segment of a literal `path` may be a
wildcard: `*` is exactly one segment, `**` any number of segments, none
included, so `/api/projects/{id}/**` covers `/api/projects/7` and
`/api/projects/7/members` but not `/api/projects/70`. There is no `?`, no
character class and no alternation (`{name}` is a variable). Exact stays the
default, a subtree is opted into with `/**`, a wildcard comes from the literal
template alone, and a `pathParams` value is encoded before matching, so a `*` in
it is text. The rows are `conformance/invalidations.json`. A wildcard in any
other address is `SCHEMA_VIOLATION`.

Which reads a write invalidates is the write's, not the place's, so it is
announced wherever the mutation ran — from a row, a form's `autosave` or an
`onSubmit` alike.

## Calls

A call is a pressed run of a mutation: the mutation, what it is sent, and what
follows and is drawn of its answer where it ran. Each place that runs one holds
a closed shape listing exactly the keys that mean something there; any other key
is `SCHEMA_VIOLATION`.

### `Ui.MutationCall`

The shape of each entry of `rowActions` on a [`Ui.Listing`](listing.md#row-actions)
and a [`list` node](nodes.md#values-and-lists), of a markdown node's
[`annotations.action`](nodes.md#markdown) and of a [`button` node](nodes.md#buttons)'s
`action`:

| Field | | |
| --- | --- | --- |
| `mutation` | required | the write run: a `!ref`, or one inline |
| `inputs` | required | what the mutation receives, by input property: a path into a root in scope — `prompt` among them where the call asks — or a fixed value; `{}` for a mutation that takes nothing |
| `label` | required | the button's accessible name; include the text the button shows |
| `confirm` | | a question asked before the write runs |
| `prompt` | none | a [`Ui.Prompt`](#asking-first): a dialog asking for entries before the write runs |
| `enabled` | always | when the button can be pressed, and why not: a [`Ui.Enablement`](conditions.md#enablement) over the roots in scope |
| `onSuccess` | none | [effects](#after-a-success) run in order once the write succeeds |
| `onFailure` | none | [effects](#after-a-success) run in order when the write does not succeed, over `error` and `input` |
| `result` | nothing drawn | a [node tree](nodes.md) drawn of a success, over `result` and `input` |
| `failure` | the error's code and message | a node tree drawn when the write does not succeed, over `error` and `input` |

`inputs` is judged against the mutation's `inputModel` as a call's arguments are
(`CONTRACT_INPUTS_MISMATCH`, `CEL_UNKNOWN_FIELD`, `CEL_TYPE_ERROR`,
`ACCESSOR_NOT_PLAIN_CHAIN`), over what is in scope where it is written: in a
listing, `row`, the listing's declared `query`, `params` and `form`; in a list,
`row` and the roots of the tree it sits in; on a button, the roots of that tree
— `result`, `input` and `values` in an answer, `data`, `query` and `params` in a
query node. A root nothing binds there is `CEL_UNKNOWN_IDENTIFIER`. The inputs
are read when the button is pressed, and every input the mutation requires is
bound.

```yaml
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
```

A row and a button are each one entry: it takes no press while its last is
pending or queued. A pressed call draws its own `result` tree in place of its
button — over its own `result` and `input` — and its `failure` tree beside the
button, unless a confirmation was open, where the refusal is shown instead. In a
listing a record's answer lasts while that record is shown, through the reload
its own success causes; in a list it lasts as long as the answer the list is
drawn from. The trees sit in the `mutation-result` and `mutation-failure`
[parts](https://hub.telo.run/module/oci/ghcr.io/telorun/ui-react/).

### `Ui.Move`

A layout's [`move`](listing-layouts.md#moving-a-record) is a gesture with no
button, so its shape is a call without a `label` — the "Move to" menu names the
target — and without a `result`, since the success is the record in its new
place: `{ mutation, inputs, confirm?, prompt?, enabled?, onSuccess?, onFailure?, failure? }`.
Its `failure` is drawn on the record.

### On a form

A [form](form.md) runs a mutation too, from `onSubmit` (pressed) or `autosave`
(as the values settle). Their shapes are the form's: `onSubmit` is `{ mutation,
inputs, label?, confirm?, enabled?, result?, failure? }` and `autosave` is
`{ mutation, inputs, debounce?, result?, failure? }`. Neither takes `prompt` —
the form enters the fields — nor `onSuccess`, which is the form's own, since a
form makes one submit write and what follows it is one list. See
[`onSubmit`](form.md#onsubmit) and [`autosave`](form.md#autosave).

## Asking first

`prompt` holds a `Ui.Prompt`, inline or by `!ref`:

| Field | | |
| --- | --- | --- |
| `model` | required | the shape of what is entered |
| `fields` | every enterable property | the fields, top to bottom: a property name, or a [field kind](field-kinds.md) |
| `groups` | none | labelled sections the fields name by `group` |

Pressing the call opens a dialog — titled with `confirm`, or with the label —
holding those fields, validated in the page against `model` before the write is
sent. `inputs` reads what was entered through the **`prompt` root**
(`note: !cel "prompt.note"`), typed from the prompt's `model` and withheld where
the call has no prompt, so reading it there is `CEL_UNKNOWN_IDENTIFIER`.

```yaml
rowActions:
  - mutation: !ref reject            # inputModel: { id, note }
    inputs: { id: !cel "row.id", note: !cel "prompt.note" }
    label: Reject
    prompt:
      kind: Ui.Prompt
      model:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [note]
          properties: { note: { type: string, title: Note, minLength: 1 } }
```

Every input the mutation requires is bound in `inputs`, the prompt's entries
included: one left unbound is `CONTRACT_INPUTS_MISMATCH`. The dialog holds the
prompt's entries alone, so a required entry left empty blocks sending. A 400 to
a prompting call is shown on the dialog's fields as a form's is.

The field rules are the prompt's, as they are a form's:
`UI_FIELD_REQUIRED_NOT_ENTERED`, `UI_FIELD_UNSUPPORTED` and the rest of
[the form's field rules](form.md#refused) are reported at the `Ui.Prompt`.

### `Ui.MutationPress`

A call is one shape over a smaller one. `Ui.MutationPress` is a mutation run by
a press and the effects that follow its answer: `{ mutation, inputs, label?,
onSuccess?, onFailure? }`. `Ui.MutationCall` extends it — `label` required —
adding `confirm`, `prompt`, `enabled`, `result` and `failure`, the parts that
ask first and draw an answer in place. A [toast's `call`](toasts.md#uitoast)
holds the smaller shape, `label` required: a `result:` there is
`SCHEMA_VIOLATION`.

## After a success

`onSuccess` is a list of [`Ui.Effect`](presses.md)s written in place, run in the
order written, each after the one before has happened. Today an effect is a
destination — a [`Ui.Navigate`](presses.md#uinavigate) or a
[`Ui.OpenPage`](presses.md#uiopenpage) — over `result` and `input`: an
app-relative address of a declared page moves within the application, any other
app-relative address is loaded, and an `https://`, `http://` or `mailto:`
address replaces the page. An address that does not resolve goes nowhere, and
the answer is still drawn. Anything but an effect in the list is
`REFERENCE_KIND_MISMATCH`, and an old `onSuccess: { to: … }` is
`SCHEMA_VIOLATION`.

The effects are resolved when the answer arrives and run by the page shell, not
by the component that made the call, so they run even when that component's
surface has closed. After the call's own answer is drawn and the mutation's
reads are announced, they run in order.

An effect reading `result` makes the success's body read, as a `result` tree or
an `invalidates` entry reading it does; otherwise any 2xx is a success, whatever
it carries. An empty 2xx, a 204 included, is a success unless something reads
`result`, in which case it is `ERR_UI_RESPONSE_INVALID`.

What follows a success depends on where the write was made, so it belongs to the
call and not to the mutation: one mutation saves and stays from an autosave,
saves and navigates from a submit, and saves silently from a row.

`onFailure` is the same list for a write that does not succeed — any answer but
a 2xx, no answer at all, or a 2xx body the output model refuses — over `error`
and `input`, run after the call's `failure` tree is drawn. `result` is not in
scope there, nor `error` in `onSuccess`: reading either is
`CEL_UNKNOWN_IDENTIFIER`. Besides destinations an effect is a
[`Ui.Toast`](toasts.md#uitoast) or a [`Ui.Close`](toasts.md#uiclose).

## The answer

`result` and `failure` are ordinary [node trees](nodes.md) whose
[accessors](https://telo.run/docs/extend/accessor-fields) read these roots, each
typed as declared:

| Root | In | Is |
| --- | --- | --- |
| `result` | `result`, `onSuccess` | the answer, typed from `outputModel`; with none it has no members, so any `result.<name>` is `CEL_UNKNOWN_FIELD` |
| `error` | `failure`, `onFailure` | a [`Ui.RequestError`](conditions.md): `status` (absent when nothing answered), `code`, `message` |
| `input` | `result`, `failure`, `onSuccess`, `onFailure`, and the mutation's `url` and `invalidates` | the record that was sent, typed from `inputModel` |
| `values` | a form's `result` and `failure` | what the form holds now, typed from the form's `model` |

`failure` is drawn for every answer but a 2xx — a 400 still marks the fields it
names — for no answer at all, and for a 2xx body that is not a JSON object or
that `outputModel` refuses (`code: ERR_UI_RESPONSE_INVALID`). A record that fails
the mutation's `inputModel` before it is sent draws it too, with
`code: ERR_UI_MUTATION_INPUT_INVALID` and nothing sent. Left out, it draws the
error's code and message.

A `when` in either tree is evaluated once, when the tree is resolved, over what
exists then (`variables`, `secrets`, `resources`); a node whose `when` is false is
not delivered.

## Pressing and `concurrency`

A button, or one row, takes no press while its last is pending or queued. With
`concurrency: serial` the calls of the mutation — from a row, a button, a form's
`onSubmit` and its `autosave` alike — run one after another, in the order they
were made on this page; with `parallel` they run at once. Either way the record
sent is the one entered when the button was pressed. `serial` orders the calls
of one page and promises nothing about the operation itself.

An autosave takes its turn in the same queue as the presses: under `serial`, a
pending autosave write waits behind the calls ahead of it, takes every change
made meanwhile and goes once, with the newest record. The coalescing is the same
under both values; see [`autosave`](form.md#autosave).

## What `telo check` says

| Written | Reported |
| --- | --- |
| `value: !cel "row.nmae"`, `rows: !cel "result.fiels"` in a `result` | `CEL_UNKNOWN_FIELD`, listing the declared members |
| `inputs` naming a property the mutation does not take, or leaving a required one out | `CONTRACT_INPUTS_MISMATCH` |
| `note: !cel "prompt.note"` on a call with no `prompt` | `CEL_UNKNOWN_IDENTIFIER` |
| a call without `label`, `prompt: true`, `label` or `result` under a `move`, `onSuccess: { to: … }`, any key the holder's shape does not list | `SCHEMA_VIOLATION` |
| `{ kind: Ui.Dialog }` in an `onSuccess` list | `REFERENCE_KIND_MISMATCH` |
| `method: GET`, an absolute `url`, a page reference as a `url`, a key the kind does not take | `SCHEMA_VIOLATION` |
| `kind: Ui.Action` | `UNDEFINED_KIND` |

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_MUTATION_INPUT_UNSENT` | a `DELETE` whose `url` does not consume every `inputModel` property as exactly `input.<property>` (`ERR_UI_MUTATION_INPUT_UNSENT` when first read) |

A call refuses inputs that make no record of the mutation's input model — a key
it does not take, a fixed value its property refuses, a required input left
unbound — as `ERR_UI_MUTATION_CALL_INPUTS_INVALID` wherever its tree is
resolved, for a manifest that never passed `telo check`.

## What a renderer receives

A mutation is a `Ui.MutationSpec`:

| Member | |
| --- | --- |
| `id` | the declaration's identity, so every call of it shares one `concurrency` queue |
| `schema` | the input model's JSON Schema |
| `answer` | the output model's JSON Schema, present when one is declared |
| `method` | always present (`POST` by default) |
| `url` | an [address](nodes.md#addresses) `{ path, pathParams, queryParams }` whose bindings read `input` |
| `consumed` | the input properties the url reads whole, in the input model's order — the renderer sends the others in the body, with no CEL of its own |
| `invalidates` | addresses over `input` and `result`; `[]` when none |
| `concurrency` | `parallel` or `serial` |

A call is `{ mutation, inputs, label, confirm?, prompt, enabled?, onSuccess,
onFailure, result?, failure }`: `inputs` bindings, `prompt` a prompt spec `{ schema, fields,
groups }` or `null`, `onSuccess` a list of effect specs (`[]` when none) over
`result` and `input`, `onFailure` the same over `error` and `input`, `result` present when written, `failure` the tree with the
default filled in. A move is the same without `label` and `result`. A form's
`onSubmit` and `autosave` are described with [the form](form.md#what-a-renderer-receives).
