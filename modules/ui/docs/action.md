# Ui.Action

A button that runs an operation, with a form for what the operation takes, and
what it answered drawn under it — a `result` tree for a success, a `failure`
tree for anything else.

| Field | | |
| --- | --- | --- |
| `inputModel` | required | the shape of the record sent: a `!ref` to a `Telo.JsonSchema`, or one inline |
| `outputModel` | | the shape of the answer, read as `result`; a success's body is held to it |
| `source.path` | required | [app-relative](nodes.md#addresses) URL of the operation |
| `label` | required | the text of the button |
| `fields` | every enterable property | the fields, top to bottom: a property name, or a [field kind](field-kinds.md), none entering a property twice |
| `groups` | none | labelled sections the fields name by `group` ([field kinds](field-kinds.md#groups)) |
| `state` | not kept | where the values entered are kept between visits ([kept values](field-kinds.md#kept-values)) |
| `enabled` | always | when the button can be pressed, and why not: a [`Ui.Enablement`](conditions.md#enablement) over `values` |
| `result` | nothing drawn | a [node tree](nodes.md) drawn from a success, over `result`, `input` and `values` |
| `failure` | the error's code and message | a node tree drawn when the operation does not succeed, over `error`, `input` and `values` |
| `onSuccess` | nothing | `{ navigate?, refreshes? }`: where the page goes, and what is read again |
| `concurrency` | `parallel` | `parallel` or `serial`: whether presses run at once or one after another |
| `clearAnswerOn` | none | input properties whose change clears what was drawn from the last answer |

The operation must speak [the action contract](action-contract.md): one `POST`
with a JSON body, answered with a JSON object on success and a problem body
(`code`, `detail`, a 400's `data.issues`) otherwise.

```yaml
kind: Ui.Action
metadata: { name: generateReports }
inputModel: !ref ReportRequest
outputModel: !ref ReportAnswer
source: { path: /api/reports }
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

An action is a [composite](composite.md): it is placed on a page with
`{ type: composite, ref: !ref generateReports }`, or
[offered on each row](#row-actions) of a table or a `list` node.

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
| `result` | `result`, `onSuccess.navigate` | the answer, typed from `outputModel`; with none it has no members, so any `result.<name>` is `CEL_UNKNOWN_FIELD` |
| `error` | `failure` | a [`Ui.RequestError`](conditions.md): `status` (absent when nothing answered), `code`, `message` |
| `input` | `result`, `failure` | the record that was sent, typed from `inputModel` |
| `values` | `result`, `failure` | what the form holds now, typed from `inputModel`; from a row, the record the press sent |

`failure` is drawn for every answer but a 2xx — a 400 still marks the fields
it names — for no answer at all, and for a 2xx body that is not a JSON object
or that `outputModel` refuses (`code: ERR_UI_RESPONSE_INVALID`). Left out, it
draws the error's code and message.

A success's body is read only when the `result` tree or `onSuccess.navigate`
reads `result`; otherwise any 2xx is a success, whatever it carries.

The answer drawn is cleared when a submission starts, and when the value of a
property `clearAnswerOn` lists changes — a row's answers drawn inside it go
with it.

## After a success

`onSuccess.refreshes` lists [app-relative](nodes.md#addresses) paths: every
[`Ui.Data`](data.md) whose `source.path` and every [`Ui.Table`](table.md)
whose `source.basePath` equals one of them reads again.

`onSuccess.navigate` is a path into `result`, or a fixed address. An
app-relative address of a declared page moves within the application; any
other app-relative address is loaded; an `https://`, `http://` or `mailto:`
address replaces the page. A value that is no such address navigates nowhere,
and the answer is drawn.

## Pressing

The form takes no press while its last is pending or queued. With
`concurrency: serial` the presses of the action — its form's and its rows'
alike — run one after another, in the order they were made on this page; with
`parallel` they run at once. Either way the record sent is the one entered when
the button was pressed. `serial` orders the presses of one page and promises
nothing about the operation itself.

## Row actions

A [`Ui.Table`](table.md#row-actions) and a [`list` node](nodes.md#values-and-lists) offer
an action on every row through `rowActions`, each entry a `Ui.RowAction`:

| Field | | |
| --- | --- | --- |
| `action` | required | the action run: a `!ref`, or one inline |
| `inputs` | required, at least one | what the action receives, by input property: a path into `row` or another root in scope, or a fixed value |
| `confirm` | | a question asked before it runs |
| `prompt` | `false` | whether a press opens a dialog for the action's fields `inputs` does not bind |
| `enabled` | always | when the row's button can be pressed, over `row` and the roots in scope; the action's own `enabled` does not govern it |

`inputs` is judged against the action's input model as a call's arguments are
(`CONTRACT_INPUTS_MISMATCH`, `CEL_UNKNOWN_FIELD`, `CEL_TYPE_ERROR`,
`ACCESSOR_NOT_PLAIN_CHAIN`), over `row` plus what is in scope where the rows
are drawn: in a table, the table's declared `query`; in a list, the roots of
the tree the list sits in — `result`, `input` and `values` in an answer, `data`
and `query` in a reader. A root nothing binds there is `CEL_UNKNOWN_IDENTIFIER`.
Every required input is bound there, and the inputs are read when the button is
pressed.

A row is one entry: it takes no press while its last is pending or queued. A
pressed action draws its own `result` tree — over its own `result`, `input`
and `values`, the last being the record sent — in place of its button, and its
`failure` tree beside the button, unless a confirmation was open, where the
refusal is shown instead. The action's `onSuccess` and `concurrency` apply
wherever it runs, and a table reads its rows again after any success. In a
table a row's answer lasts while that row is on the shown page, through the
reload its own success causes; in a list it lasts as long as the answer the
list is drawn from.

## What `telo check` says

| Written | Reported |
| --- | --- |
| `value: !cel "row.nmae"`, `rows: !cel "result.fiels"` in `result` | `CEL_UNKNOWN_FIELD`, listing the declared members |
| a `list`'s `rows` naming something that is not a list | `CEL_TYPE_ERROR` |
| `rows: !cel "size(result.files)"`, or any other expression | `ACCESSOR_NOT_PLAIN_CHAIN` |
| `navigate: ftp://…`, `refreshes: [api/reports]` | `SCHEMA_VIOLATION` |
| a key the kind does not take (`method: PUT`, `lists`) | `SCHEMA_VIOLATION` |
| a row action's input the action does not take, or a required one left out | `CONTRACT_INPUTS_MISMATCH` |

## Refused

| Rule (`RESOURCE_RULE_VIOLATED`, in `data.rule`) | When |
| --- | --- |
| `UI_FIELD_*`, `UI_STATE_FIELD_UNKNOWN` | the field rules a [form](form.md#refused) has, over `inputModel`; a property `inputModel` requires with no field is `UI_FIELD_REQUIRED_NOT_ENTERED` |
| `UI_ACTION_CLEAR_UNKNOWN_PROPERTY` | `clearAnswerOn` names a property `inputModel` does not declare |

The action refuses the same things itself when it is first read, as
`ERR_<code>` — each field kind answering for its own fit — for a manifest that never passed
`telo check`; a table or a list refuses row inputs that make no record of the
action's input model as `ERR_UI_ROW_ACTION_INPUTS_INVALID`.

A reference on the way to a member a `value` or `list` node names that names
nothing, or leads back to itself, is `ERR_REF_UNRESOLVED` when the action is
first read, naming the action and the place. `telo check` does not report it.

## What a renderer receives

An `action` node:

| Member | |
| --- | --- |
| `schema` | the input model's JSON Schema |
| `path`, `label` | as declared |
| `fields` | each field kind's [spec](field-kinds.md#what-a-renderer-receives), its label the property's `title`, else its name |
| `groups` | `{ name, label, description?, shown? }` each; empty when none |
| `state` | `{ key?, address, store, fields }` ([kept values](field-kinds.md#kept-values)) |
| `enabled` | present when declared, as written |
| `answer` | the output model's JSON Schema, present when one is declared |
| `result` | the `result` tree, its `value` and `list` nodes [presented](nodes.md#values-and-lists) from the roots they read; present when declared |
| `failure` | the `failure` tree, the default filled in |
| `onSuccess` | `{ navigate?, refreshes }`: `navigate` a binding, present when declared; `refreshes` empty when none |
| `concurrency` | `parallel` or `serial` |
| `clearAnswerOn` | the listed properties; empty when none |

A row action is `{ action, inputs, confirm?, prompt?, enabled? }`: `action` the
action's own node, `inputs` bindings, `prompt` — present when the press
prompts — `{ fields }`, the action's fields `inputs` does not bind.
