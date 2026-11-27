# Toasts and closing

A page has no way to say "it happened" with a drawn answer: a row call that
archives a record draws its answer in place, and the refresh that follows drops
the row and the answer with it. A **toast** reports that event — "Apollo
archived", with a link to the project and an Undo — and a `Ui.Close` ends the
surface the write was pressed in.

**One principle.** A toast reports an *event*; a *state* (a read failed, a field
is invalid, a copy succeeded) stays drawn where it holds. A toast is never the
only record of an outcome, nor the only way to act on one: its `link` and `call`
are shortcuts to what the page offers elsewhere, so a toast can be dropped
safely. Write the Undo's twin where the record lives (an Archived page with
Restore), and keep the `failure` tree a call draws.

Both are [effects](presses.md#effects) — kinds extending `Ui.Effect` — written in
any `onSuccess` or `onFailure` list beside the destinations, and run in the order
written.

## `Ui.Toast`

| Field | Default | |
| --- | --- | --- |
| `text` | required | a [`Ui.BoundText`](texts.md#a-text-over-data): one sentence, translated and announced as one |
| `tone` | `success` in an `onSuccess` list, `danger` in an `onFailure` list | `info`, `success`, `warning` or `danger` |
| `link` | none | a [`Ui.Press`](presses.md#presses) `{ to, label }` — "View" — drawn as a link |
| `call` | none | a [`Ui.MutationPress`](mutation.md#uimutationpress) — Undo, Retry — with `label` required |

```yaml
rowActions:
  - mutation: !ref archiveProject
    inputs: { id: !cel "row.id" }
    label: Archive
    onSuccess:
      - kind: Ui.Toast
        text: { text: "{$name} archived.", values: { name: !cel "result.name" } }
        link:
          label: View
          to: { kind: Ui.OpenPage, page: !ref projectPage, pathParams: { id: !cel "result.id" } }
        call:
          label: Undo
          mutation: !ref restoreProject
          inputs: { id: !cel "result.id" }
          onSuccess: [{ kind: Ui.Toast, text: Restored. }]
    onFailure:
      - kind: Ui.Toast
        tone: warning
        text: { text: "Could not archive the project: {$message}", values: { message: !cel "error.message" } }
        call:
          label: Retry
          mutation: !ref archiveProject
          inputs: { id: !cel "input.id" }
```

**What a toast reads.** Its `text` values, `link.to` and `call.inputs` read the
roots of the list holding it — `row`, `result`, `error`, `input`, `values`,
`params`, `query` — resolved when it is posted, so a toast outlives its row. The
call's own `onSuccess` and `onFailure` bind that call's own `result`, `error` and
`input`, shadowing the outer ones.

**The `call`.** A toast's call asks nothing and draws no tree: a `result:`
beside it, or a call without `label`, is `SCHEMA_VIOLATION`. It is busy while
pending; on success the toast is withdrawn and the call's `onSuccess` runs; on
failure the toast stays, its button pressable again, and the call's `onFailure`
runs. Omitted, `onFailure` is one `danger` toast reading `{$message}` over
`error.message`, so a failed Undo is never silent. A call leading back to its own
mutation (Retry) is not a cycle: every edge waits for a person. Its `inputs` are
refused as any call's are (`CONTRACT_INPUTS_MISMATCH`,
`ERR_UI_MUTATION_CALL_INPUTS_INVALID` when first read).

**The `link`.** A toast sits in no surface, so a `Ui.OpenPage` there opens a
`Ui.ViewportOverlay` as declared, any other surface as its `compact`, else as a
`Ui.Dialog` with its defaults.

## `Ui.Close`

`Ui.Close` closes the opened surface the call ran in — for a toast's `call`, the
surface the posting call ran in — if it is still open. It extends `Ui.Effect`
directly and not `Ui.Destination`: it has no address, so it cannot be drawn as a
link, and at any `to` slot it is `REFERENCE_KIND_MISMATCH`.

```yaml
action:
  mutation: !ref archiveProject
  inputs: { id: !cel "params.id" }
  label: Archive
  onSuccess:
    - { kind: Ui.Close }
    - kind: Ui.Toast
      text: { text: "{$name} archived.", values: { name: !cel "result.name" } }
```

## Where effects are written

`onFailure` stands beside every `onSuccess`, and nowhere else:

- a call (`Ui.MutationCall`: a `button` node, `rowActions`, `annotations.action`),
  a `Ui.Move` and a toast's `call` — `onSuccess` over `result` and `input`,
  `onFailure` over `error` and `input`;
- a [`Ui.Form`](form.md#onfailure) — `onSuccess` over `values` and `result`,
  `onFailure` over `values` and `error`;
- a [`Ui.Listing`'s `delete`](listing.md#delete) — over `row`, plus `error` in
  `onFailure`.

`result` is not in scope in an `onFailure` list, nor `error` in an `onSuccess`
list: reading it is `CEL_UNKNOWN_IDENTIFIER`. An effect reading `result` makes
the success's body read. A failure toast adds to the `failure` tree a call
draws; it never replaces it.

## How long a toast stays, and how many show

One fixed rule, with no key to change it. An `info` or `success` toast with no
`link` and no `call` leaves after 6 seconds, its timer standing still while the
pointer is over the toaster, the focus is inside it, or the document is hidden;
every other toast stays until dismissed, so nothing a person must operate is
timed. Every toast has a dismiss button, and Escape and a swipe dismiss too.

At most three are shown: a fourth drops the oldest toast that leaves on its own,
else the oldest. A toast equal to one shown — same tone, formatted text, link
destination, and call with its inputs — is not added again, and the one shown
restarts its timer, so a failure repeated shows once. A toast dropped or
dismissed never aborts a call already sent: its lists still run, and what they
post is shown. A toast is therefore never the only record of an outcome nor the
only way to act on one. The rows are in `conformance/toasts.json`.

A `Ui.Close` in the lists of a toast's `call` closes the opened page the posting
call ran in, if that page is still open. A toast after a `Ui.Navigate`
to a declared page shows on the page moved to; a navigation to any other address
is an ordinary browser load, which drops every toast.

## Texts

The region the renderer draws the toasts in is named by the keyed text
`toaster` ("Notifications"), in `Ui.Translations` and its fourteen translations.

## What a renderer receives

A toast is a `Ui.ToastSpec` and a close a `Ui.CloseSpec`, branches of
`Ui.EffectSpec` tagged on `type`:

```json
{ "type": "close" }
```

```json
{
  "type": "toast",
  "text": {
    "text": { "text": "{$name} archived.", "context": null, "lang": "en", "computed": false },
    "values": { "name": { "root": "result", "path": ["name"] } }
  },
  "tone": "success",
  "link": { "to": { "type": "openPage", "...": "..." }, "label": { "text": "View", "context": null, "lang": "en", "computed": false } },
  "call": {
    "mutation": { "id": "...", "...": "..." },
    "inputs": { "id": { "root": "result", "path": ["id"] } },
    "label": { "text": "Undo", "context": null, "lang": "en", "computed": false },
    "onSuccess": [],
    "onFailure": [{ "type": "toast", "tone": "danger", "text": "…" }]
  }
}
```

`tone` is always present, filled by `ui` from the list holding the toast. `link`
and `call` are present only when written; `call` is a `Ui.MutationPressSpec`,
every member present, its `onFailure` holding the filled default when the
manifest omits it. Every `onSuccess` is paired with an `onFailure` (`[]` when
none) on every call spec and on the `form` node, and a listing's `delete` is
`false` or `{ onSuccess, onFailure }`.
