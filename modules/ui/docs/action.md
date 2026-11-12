# Ui.Action

A button that runs an operation, with a form for what the operation takes, and
what it answered drawn under it — a `result` tree for a success, a `failure`
tree for anything else.

| Field | | |
| --- | --- | --- |
| `inputModel` | required | the shape of the record sent: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `outputModel` | | the shape of the answer, read as `result`; a success's body is held to it |
| `request` | required | `{ method?, target }`: the HTTP `method` (`POST`, the default, `PUT`, `PATCH` or `DELETE`) and the `target`, a [request target](nodes.md#addresses) over `input` |
| `label` | required | the text of the button |
| `fields` | every enterable property | the fields, top to bottom: a property name, or a [field kind](field-kinds.md), none entering a property twice |
| `groups` | none | labelled sections the fields name by `group` ([field kinds](field-kinds.md#groups)) |
| `state` | not kept | where the values entered are kept between visits ([kept values](field-kinds.md#kept-values)) |
| `enabled` | always | when the button can be pressed, and why not: a [`Ui.Enablement`](conditions.md#enablement) over `values` |
| `result` | nothing drawn | a [node tree](nodes.md) drawn from a success, over `result`, `input` and `values` |
| `failure` | the error's code and message | a node tree drawn when the operation does not succeed, over `error`, `input` and `values` |
| `onSuccess` | nothing | `{ navigate?, refreshes? }`: an [address](nodes.md#addresses) the page goes to over `result` and `input`, and the request targets read again over `input` and `result` |
| `concurrency` | `parallel` | `parallel` or `serial`: whether presses run at once or one after another |
| `clearAnswerOn` | none | input properties whose change clears what was drawn from the last answer |

The operation must speak [the action contract](action-contract.md): one
`<method> <target>` request, its JSON body the input minus what the target
reads, answered with a JSON object on success and a problem body (`code`,
`detail`, a 400's `data.issues`) otherwise.

```yaml
kind: Ui.Action
metadata: { name: generateReports }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
request: { target: /api/reports }
label: Generate
result:
  type: list
  heading: Files
  rows: !cel "result.files"
  columns:
    - value: !cel "row.name"
    - header: Download
      value: !cel "row.url"
onSuccess:
  refreshes: [/api/reports]
```

## The request

`request.target` is a [`Ui.RequestTarget`](nodes.md#addresses): an app-relative
path, or `{ path, pathParams, queryParams }` whose bindings read `input`, the
record the press sends. An input property is **consumed** when a `pathParams`
or `queryParams` binding is exactly the chain `input.<property>`; a deeper
chain (`input.range.from`) reads without consuming, and a literal consumes
nothing. A consumed property travels in the target and is left out of the body.

```yaml
kind: Ui.Action
metadata: { name: renameConversation }
inputModel: !ref ConversationRename   # { id, title }
request:
  method: PATCH
  target:
    path: "/api/chat/conversations/{id}"
    pathParams: { id: !cel "input.id" }
label: Rename
```

sends `PATCH /api/chat/conversations/<id>` with the body `{ "title": … }`.

| Method | Body |
| --- | --- |
| `POST`, `PUT`, `PATCH` | the input's properties that hold a value, minus the consumed ones |
| `DELETE` | none; every input property must be consumed |

A target whose parameter holds nothing is not sent (`ERR_UI_ADDRESS_UNRESOLVED`
as a failure, naming the parameter). A `GET`, an absolute target and a page
reference are refused: a read is a [`Ui.Data`](data.md).

An action is a [composite](composite.md): it is placed on a page with
`{ type: composite, ref: !ref generateReports }`, or run with inputs bound from
the data in scope as a [bound action](#bound-actions): on each record of a
listing or a `list` node, or from a [`button` node](nodes.md#buttons).

## Fields

The form is the one a [`Ui.Form`](form.md) draws: a labelled control per field,
[derived from the property](form.md#how-a-control-is-derived), validated in the
page against `inputModel` before anything is sent.

With `fields` left out there is one per property
[a control can enter](form.md#what-a-form-can-enter), in declaration order. An
input model with no properties gives a button and nothing else.

A field's `shown` is a [condition](conditions.md) over `values`, the record
the form holds now, typed from `inputModel` — as on a
[form](form.md#fields-drawn-on-a-condition). `enabled` is a condition over the
same `values` with the reason shown while it does not hold:

```yaml
enabled:
  at: !cel "values.month"
  matches: { type: string, minLength: 7 }
  disabledText: Choose a month first.
```

While it does not hold the button is disabled and `disabledText` is drawn
beside it; a value it reads that is missing counts as not holding.

## The answer

`result` and `failure` are ordinary [node trees](nodes.md) — text, layout,
`value` and `list` nodes, composites — whose [accessors](https://telo.run/docs/extend/accessor-fields)
read these roots, each typed as declared:

| Root | In | Is |
| --- | --- | --- |
| `result` | `result`, `onSuccess` | the answer, typed from `outputModel`; with none it has no members, so any `result.<name>` is `CEL_UNKNOWN_FIELD` |
| `error` | `failure` | a [`Ui.RequestError`](conditions.md): `status` (absent when nothing answered), `code`, `message` |
| `input` | `request.target`, `result`, `failure`, `onSuccess` | the record that was sent, typed from `inputModel` |
| `values` | `result`, `failure` | what the form holds now, typed from `inputModel`; from a row, the record the press sent |

`failure` is drawn for every answer but a 2xx — a 400 still marks the fields
it names — for no answer at all, and for a 2xx body that is not a JSON object
or that `outputModel` refuses (`code: ERR_UI_RESPONSE_INVALID`). Left out, it
draws the error's code and message.

A success's body is read only when the `result` tree, `onSuccess.navigate` or
a `refreshes` entry reads `result`; otherwise any 2xx is a success, whatever it
carries.

The answer drawn is cleared when a submission starts, and when the value of a
property `clearAnswerOn` lists changes — a row's answers drawn inside it go
with it.

## After a success

After a 2xx the resolved target's path, and each resolved `onSuccess.refreshes`
path, are announced as changed, and so is the `basePath` of the listing a row
action ran in. A [`Ui.Data`](data.md), [`Ui.Listing`](listing.md) or
[`Ui.Chat`](chat.md) whose request path equals an announced one — resolved,
encoded and app-relative, the query left out — reads again.
`onSuccess.refreshes` entries are [request targets](nodes.md#addresses) over
`input` and `result`, except that a whole segment of a literal `path` may be a
wildcard: `*` is exactly one segment, `**` any number of segments, none
included, so `/api/projects/{id}/**` covers `/api/projects/7` and
`/api/projects/7/members` but not `/api/projects/70`. There is no `?`, no
character class and no alternation (`{name}` is a variable). Exact stays the
default: an entry with no wildcard covers only its own path, and a subtree is
opted into with `/**`. A wildcard comes from the literal template alone — a
`pathParams` value is encoded before matching, so a `*` in it is text, and a
`path` read from data is matched exactly. The rows are
`conformance/refreshes.json`. A wildcard in any other address is
`SCHEMA_VIOLATION`.

`onSuccess.navigate` is an [address](nodes.md#addresses) over `result` and
`input`: a literal, `{ path, pathParams, queryParams }`, or a `path` chain
reading a whole address from the answer. An app-relative address of a declared
page moves within the application; any other app-relative address is loaded; an
`https://`, `http://` or `mailto:` address replaces the page. An address that
does not resolve navigates nowhere, and the answer is drawn.

**An empty success.** A 2xx with no body, 204 included, is a success unless
something reads `result` — the `result` tree, `navigate` or a `refreshes` entry
— in which case an empty body is `ERR_UI_RESPONSE_INVALID`.

## Pressing

The form takes no press while its last is pending or queued. With
`concurrency: serial` the presses of the action — its form's and its rows'
alike — run one after another, in the order they were made on this page; with
`parallel` they run at once. Either way the record sent is the one entered when
the button was pressed. `serial` orders the presses of one page and promises
nothing about the operation itself.

## Bound actions

A `Ui.BoundAction` runs an action with inputs bound from the data in scope. It
is each entry of `rowActions` on a [`Ui.Listing`](listing.md#row-actions) and a
[`list` node](nodes.md#values-and-lists), a layout's
[`move`](listing-layouts.md), a markdown node's
[`annotations.action`](nodes.md#markdown), and the members of a [`button`
node](nodes.md#buttons):

| Field | | |
| --- | --- | --- |
| `action` | required | the action run: a `!ref`, or one inline |
| `inputs` | required, at least one | what the action receives, by input property: a path into a root in scope — `row` among them where there is one — or a fixed value |
| `confirm` | | a question asked before it runs |
| `prompt` | `false` | whether a press opens a dialog for the action's fields `inputs` does not bind, where the person completes the record |
| `enabled` | always | when the button can be pressed, over the roots in scope; the action's own `enabled` does not govern it |

`inputs` is judged against the action's input model as a call's arguments are
(`CONTRACT_INPUTS_MISMATCH`, `CEL_UNKNOWN_FIELD`, `CEL_TYPE_ERROR`,
`ACCESSOR_NOT_PLAIN_CHAIN`), over what is in scope where it is written: in a
listing, `row`, the listing's declared `query` and the page's `params`; in a
list, `row` and the roots of the tree it sits in; on a button,
the roots of that tree — `result`, `input` and `values` in an answer, `data`,
`query` and `params` in a reader. A root nothing binds there is
`CEL_UNKNOWN_IDENTIFIER`. The inputs are read when the button is pressed.

Every required input is bound there unless `prompt: true`. A prompt asks for
the action's fields the inputs do not bind, and the person completes the
record: the dialog holds the bound values and the entered ones together against
the whole input model, so a required field left empty blocks sending, as it
does on the action's own form. The input model states what the operation
truly requires — `author` on a decision is required and entered in the prompt:

```yaml
- type: button
  inputs: { id: !cel "params.id", decision: approve, revision: !cel "data.plan.latestRevision.seq", hash: !cel "data.plan.latestRevision.hash" }
  prompt: true
  action:
    kind: Ui.Action
    inputModel: !ref PlanDecision # required: [id, decision, revision, hash, author]
    request: { target: { path: "/api/plans/{id}/decisions", pathParams: { id: !cel "input.id" } } }
    label: Approve
    fields: [id, decision, revision, hash, author]
```

The prompt asks for `author` alone. The same button with `prompt: false` is
`CONTRACT_INPUTS_MISMATCH` (`/ is missing required property 'author'`), and a
key the action does not take (`hsh`) is refused whether it prompts or not. The
action is still a complete form of its own: a required property its `fields`
leave out is `UI_FIELD_REQUIRED_NOT_ENTERED`, whatever binds it.

A row and a button are each one entry: it takes no press while
its last is pending or queued. A
pressed action draws its own `result` tree — over its own `result`, `input`
and `values`, the last being the record sent — in place of its button, and its
`failure` tree beside the button, unless a confirmation was open, where the
refusal is shown instead. The action's `onSuccess` and `concurrency` apply
wherever it runs, and a listing reads its records again after any success. In
a listing a record's answer lasts while that record is shown, through the
reload its own success causes; in a list it lasts as long as the answer the
list is drawn from.

## What `telo check` says

| Written | Reported |
| --- | --- |
| `value: !cel "row.nmae"`, `rows: !cel "result.fiels"` in `result` | `CEL_UNKNOWN_FIELD`, listing the declared members |
| a `list`'s `rows` naming something that is not a list | `CEL_TYPE_ERROR` |
| `rows: !cel "size(result.files)"`, or any other expression | `ACCESSOR_NOT_PLAIN_CHAIN` |
| `navigate: ftp://…`, `refreshes: [api/reports]` | `SCHEMA_VIOLATION` |
| `source:` (now `request.target`), `method: GET`, an absolute `target`, a page reference as a `target`, a key the kind does not take (`lists`) | `SCHEMA_VIOLATION` |
| a bound action's input the action does not take, or a required one left out by an entry that does not prompt | `CONTRACT_INPUTS_MISMATCH` |

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_FIELD_*`, `UI_STATE_FIELD_UNKNOWN` | the field rules a [form](form.md#refused) has, over `inputModel`; a property `inputModel` requires with no field is `UI_FIELD_REQUIRED_NOT_ENTERED` |
| `UI_ACTION_CLEAR_UNKNOWN_PROPERTY` | `clearAnswerOn` names a property `inputModel` does not declare |
| `UI_ACTION_INPUT_UNSENT` | a `DELETE` whose target does not consume every `inputModel` property as exactly `input.<property>` (`ERR_UI_ACTION_INPUT_UNSENT` when first read) |

The action refuses the same things itself when it is first read, as
`ERR_<code>` — each field kind answering for its own fit — for a manifest that never passed
`telo check`; a listing, a list, a markdown node's annotations and a button
refuse inputs that make no record of the action's input model — a key it does
not take, a fixed value its property refuses, a required input left unbound by
an entry that does not prompt — as `ERR_UI_BOUND_ACTION_INPUTS_INVALID`.

A reference on the way to a member a `value` or `list` node names that names
nothing, or leads back to itself, is `ERR_REF_UNRESOLVED` when the action is
first read, naming the action and the place. `telo check` does not report it.

## What a renderer receives

An `action` node:

| Member | |
| --- | --- |
| `schema` | the input model's JSON Schema |
| `request` | `{ method, target, consumed }`: `method` always present (`POST` by default), `target` an [address](nodes.md#addresses) `{ path, pathParams, queryParams }` whose bindings read `input`, `consumed` the input properties the target reads whole, in the input model's order — the renderer sends the others in the body, with no CEL of its own |
| `label` | as declared |
| `fields` | each field kind's [spec](field-kinds.md#what-a-renderer-receives), its label the property's `title`, else its name |
| `groups` | `{ name, label, description?, shown? }` each; empty when none |
| `state` | `{ key?, address, store, fields }` ([kept values](field-kinds.md#kept-values)) |
| `enabled` | present when declared, as written |
| `answer` | the output model's JSON Schema, present when one is declared |
| `result` | the `result` tree, its `value` and `list` nodes [presented](nodes.md#values-and-lists) from the roots they read; present when declared |
| `failure` | the `failure` tree, the default filled in |
| `onSuccess` | `{ navigate?, refreshes }`: `navigate` an address over `result` and `input`, present when declared; `refreshes` addresses over `input` and `result`, empty when none |
| `concurrency` | `parallel` or `serial` |
| `clearAnswerOn` | the listed properties; empty when none |

A bound action is `{ action, inputs, confirm?, prompt?, enabled? }`: `action` the
action's own node, `inputs` bindings, `prompt` — present when the press
prompts — `{ fields }`, the action's fields `inputs` does not bind.
