# Problem Details for every error the HTTP server renders

## Problem

The server answers failures in four shapes:

- **Coded errors use `{ error: { code, message, data } }` as `application/json`.** This covers a throw no `catches:` rung claims (500), a `catches:` entry with no `body:`, 413 `ERR_REQUEST_BODY_TOO_LARGE` and 421 `ERR_HOST_NOT_SERVED`.
- **406 uses `{ error: { code: "NOT_ACCEPTABLE", message, available } }`.**
- **Request validation 400 uses `{ error: "ValidationError", message, status, details[] }`.** crud hand-writes the same shape for `ERR_CRUD_QUERY_INVALID`.
- **A plain crash and the default 404 use Fastify's `{ statusCode, error, message }`.** This leaks the internal message.

The ui-react renderer reads a fifth shape, `code` and `message` at the top level. It never finds the server's nested `error.code`, so every unclaimed server error is shown as `ERR_UI_REQUEST_FAILED`.

Every message on the wire is a developer's English string, which nothing can check or translate.

## Solution

Every error the server builds itself is RFC 9457 Problem Details, sent as `application/problem+json`. An entry with its own `body:` still renders what it writes.

**Members:**

| Member | Content |
|---|---|
| `type` | Always `"about:blank"` |
| `title` | The RFC 9110 reason phrase for the status. Never localized; omitted for an unregistered status |
| `status` | The status code |
| `detail` | The error's `displayMessage`; present only when it has one |
| `code` | The error's code |
| `data` | The error's data, unchanged; omitted when absent |

The developer `message` never reaches the wire. It stays in the deciding-error log record and the trace.

**Responses:**

- **Unclaimed coded throw:** 500 problem.
- **Entry with no `body:`:** the entry's status with the default problem. The catches `content` schema admits a missing `body:` only under the key `application/problem+json` and requires `body:` under every other key, so `telo check` refuses any other bodiless key (`DEPENDENT_SCHEMA_MISMATCH`). The kernel does not validate a schema borrowed through `x-telo-schema-from`, so a dependency's bodiless entry under another key still reaches the dispatcher, which sends its problem as `application/problem+json`.
- **413 and 421:** problems under their existing codes.
- **406:** a problem with `code: ERR_NOT_ACCEPTABLE` (renamed from `NOT_ACCEPTABLE`) and `data.available`.
- **Validation 400:**
  - `code: ERR_INPUT_INVALID`, `detail` from that code's built-in text.
  - Findings in `data.issues[]`, each `{ pointer, keyword, params }`.
  - `pointer` is a JSON Pointer into the request as CEL sees it (`/body/month`, `/query/sort`, `/params/id`, `/headers/x-api-key`).
  - `keyword` / `params` come from one closed vocabulary kept as built-in data: the JSON Schema keywords the validators report, each with its `params` names. Anything else is `invalid`.
  - Findings carry no prose.
- **Uncoded failure:** exactly `{ type, title, status }`. That is 500, or the framework's own 4xx for a malformed request; the default 404 is the same.

**Catches:**

- **An error is never refused for `Accept`.** A catches entry whose content keys match nothing uses its first key.
- **`problem` binding.** Catches CEL gains `problem`: the default problem that entry would render, with `data` typed from the matched codes' `data` schemas. A custom body can reshape it without losing `detail`.
- **Caught members are annotated, not named.** A catch list's context bindings mark their members `x-telo-caught-member: code | data`. The CEL check types every `data`-marked node from the entry's matched codes (`CEL_UNKNOWN_FIELD`, completion and hover from the ordinary check), and the `when:` coverage proof reads any chain reaching a `code`-marked node, so `problem.code == 'X'` proves coverage as `error.code` does. The analyzer no longer reads the name `error` in catch-list analysis. A mark outside a catch list's context, or a `code` mark on a non-string, is `CAUGHT_MEMBER_MISPLACED`; a catch list whose context marks no `code` is `CAUGHT_MEMBER_MISSING` (both warnings). Step `catch:` error contexts carry no marks. `notFoundHandler.catches` gains its context (`request`, `error`, `problem`). The core migration `caught-member-marks` (`DEPRECATED_IMPLICIT_CAUGHT_MEMBER`) adds the marks to published artifacts at load, and adds the whole context to a published `notFoundHandler.catches` that has none (the migration vocabulary gains a structured-value write). `http-server` and `mcp-server` mark every catch list.

**Two messages on every error:** `message` is the developer's string (logs, traces, never the wire); `displayMessage` is the text for a person, a `Text` where an author writes it and a `TextRecord` once attached. It is stored in its source language; a transport translates it when it renders.

**Where display messages are declared:**

- **On a code.** `throws.codes.<CODE>.displayMessage` is a `Text`, beside `description`.
  - Its placeholders may name only required scalar properties of the sibling `data` schema. This is stated by a new annotation, `x-telo-text-values-from: "0/data"`.
  - A placeholder naming anything else is `MESSAGE_PLACEHOLDER_UNBOUND` / `MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED`.
- **`throws.codes` is legal on every declarable capability**, so `Http.Server` and `Http.Api` declare the refusals they answer with. Only dispatchable capabilities feed throw unions and ceilings, and `inherit` / `passthrough` stay limited to them.
- **On a `throw` step:** `{ code, message?, displayMessage?, data? }`.
  - `message` is the developer string, computed values allowed.
  - `displayMessage` is a literal `Text` with values from `data` (`x-telo-text-values-for: /displayMessage`), a `TextRecord` (`!cel "error.displayMessage"`), or null. Any other expression there is `TEXT_ARGUMENT_COMPUTED` / `ERR_TEXT_ARGUMENT_COMPUTED`.
  - Without `message`, the developer message is the display message formatted in its source language with `data`, else the code.
  - Inside a `catch:` branch, a `throw` records the caught failure as the new error's `cause`, written in the log record's cause chain; it is not in CEL, on the wire or in a journal.
- **`rethrow: {}`** re-raises the caught failure unchanged (code, messages, data, cause, stack). It is legal only under a non-nullable `error` (inside `catch:`); in `finally:` or outside any catch it is `RETHROW_WITHOUT_CAUGHT_ERROR` / `ERR_RETHROW_WITHOUT_CAUGHT_ERROR`. It adds the enclosing `try`'s propagated union to the throw union.
- **Catch contexts:** `error` gains `displayMessage`, a nullable `TextRecord`, beside `message`.
- **Kernel ambient codes** (`ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID`, `ERR_FUNCTION_FAILED`, …) get built-in display messages in `lang: en`, as data under `sdk/error-codes/` and in the `Telo.Builtins` archive. Built-in texts count as shown by every module.

**How a display message reaches the error:**

- The kernel attaches the declaring kind's display message to an error leaving a dispatch whose kind declares that code with a `displayMessage`. One already attached is never replaced.
- At the same point it checks `data` against that code's declared `data` schema. A mismatch is `ERR_OUTPUT_INVALID` naming the original code, so rendering can never fail.
- A refusal a Service renders outside a dispatch (413, 421) gets the same lookup through `ctx.declaredDisplayMessage(code, data)`.
- The controller protocol's error payload carries `displayMessage` (additive, generation `telo-7`).
- The Rust kernel accepts `throws.codes.*.displayMessage`, attaches declared display messages and checks `data`; a Rust controller error carries `data` and `displayMessage` across the C ABI and the napi bridge.

**Language:** in this plan `detail` is the text in its source language. Translating it is the application-translator plan's work.

**Package export:** `@telorun/http-dispatch` replaces `errorEnvelope` with `problemDetails`. It renders a problem from a coded error and a status.

**Readers and producers moving in the same change:**

- **ui-react:** reads top-level `code` and `detail`, falling back to its own words for 401, 403 or the status. Lands `data.issues` on the field named by the pointer segment after `/body`, worded by `Ui.Words`, which gains a word for every keyword in the vocabulary.
- **ui:** the action, collection and record contract docs, and the `Ui.RequestError` description.
- **crud:** `ERR_CRUD_QUERY_INVALID` declares a `displayMessage` and puts its findings in `data.issues`. Its `Http.Api` entry builds the 400 from `problem`, prefixing the pointers with `/query`.
- **Value-type refusals:** the invocation contract's `issues` adopt `{ pointer, keyword: format, params: { format } }`.
- **Examples and starters:** every catches `body:` that only restates code and message is deleted.
- **First-party apps and the `workflow-app` blueprint move after `http-server` is released**, in a follow-up change that bumps each one's `Http` import: hub, plan-approval and the authoring agent then answer with problems and their clients (`plan-approval-web`, studio's agent client, `plan-approval-runner`, `scripts/register-modules.mjs`) read `code` / `detail`. They import the published `http-server`, which has no `problem` binding, so moving them in this change is refused or leaks withheld messages. The `workflow-api` starter keeps its current assertions until its blueprint is re-pinned.
- **http-server catch contexts:** `error` declares `displayMessage` (a nullable `TextRecord`) beside `message`, as step `catch:` contexts do.
- **http-client:** a response whose media type is `application/json` or any `+json` suffix (RFC 6839, `application/problem+json` included) is parsed as JSON.

**No migration:** an existing `throw.message` keeps its meaning. A throw whose words are for a person moves them into `displayMessage`, by hand.

**Bookkeeping:**

- `requires:` floors on every module whose own file uses `displayMessage` (on `throw` or `throws.codes`), `rethrow`, or `throws` on a non-dispatchable kind, each verified by running the previous CLI.
- The kernel-owned refusals (a computed `throw.displayMessage`, a code display message's placeholders, `rethrow` outside a catch or in `finally:`) get their rows in `tests/check-run-agreement.yaml`. The bodiless-catch schema refusal is pinned in http-server's own tests.
- `telo release add` fragments per module and changesets for the telo version line.
- Docs: `modules/http-server/docs/returns-and-catches.md` states the problem shape normatively; also `docs/extend/text-records.md`, the primer, the hub guides and the benefits ledger ("standard API error responses").

## Decisions

- **`type` is `about:blank`, `code` is the identity.** The code already identifies a failure on every transport; a URI per code would be a second, HTTP-only identity pointing at pages app codes do not have.
- **`detail` comes only from a declared `Text`.** A controller's English string cannot be checked, translated or produced alike by both kernels.
- **Two fields, `message` and `displayMessage`, not one.** One field doing both jobs loses one of them on every rethrow and re-raise. `message` stays the developer's, as in every host language; `displayMessage` names its audience, and is stored untranslated, so `localizedMessage` would be wrong.
- **`rethrow: {}` rather than restating fields.** Copying code, messages and data by hand drops whatever member the error model gains next, and the stack and cause today.
- **Findings are data, not prose.** The reader words them, as the UI already does for its own validation. RFC 9457's illustrative `errors[]` with per-item `detail` would need a second copy of those sentences on the server.
- **No `instance` and no trace member.** They identify an occurrence, which belongs to every response rather than only failures.
- **`errorEnvelope` is removed, not reshaped.** One name for two contracts would silently change for third-party compilers.
- **One change moves every producer and reader.** Two shapes on one server is the defect being fixed.

## Example after the change

```yaml
kind: Http.Api
metadata: { name: ordersApi }
routes:
  - request: { path: /orders/{id}, method: GET }
    inputs: { id: !cel "request.params.id" }
    handler:
      kind: Run.Sequence
      steps:
        - name: missing
          throw:
            code: ORDER_NOT_FOUND
            displayMessage: "Order {$id} does not exist."
            data: { id: !cel "inputs.id" }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
    catches:
      - when: !cel "error.code == 'ORDER_NOT_FOUND'"
        status: 404
        content: { application/problem+json: {} }
```

`GET /orders/42` answers `404`, `Content-Type: application/problem+json`, with body `{"type":"about:blank","title":"Not Found","status":404,"detail":"Order 42 does not exist.","code":"ORDER_NOT_FOUND","data":{"id":"42"}}`.

## Verify

- **Default problem shape:** the unclaimed 500, a no-body catch, 413, 421 and 406 each return `application/problem+json` with exactly the members above. A client sending `Accept: application/json` still gets the error.
- **Plain crash:** a handler throwing a plain `Error` returns exactly `{"type":"about:blank","title":"Internal Server Error","status":500}`, and the message appears in the log record.
- **Validation 400:** a refused body returns `data.issues` with pointers and no validator text, and ui-react lands each issue on its field in `Ui.Words`' wording.
- **ui-react bug:** an unclaimed coded error shows its own `code` in the UI, not `ERR_UI_REQUEST_FAILED`.
- **Static refusals:** `telo check` and the kernel both refuse a computed `throw.displayMessage`, a code display message placeholder naming an optional or undeclared `data` property, and `rethrow` in `finally:` or outside a catch; `telo check` refuses a no-body entry under `text/plain`.
- **Messages stay apart:** `throw: { code, message: !cel "'x ' + y" }` passes `telo check` and renders no `detail`; a plain `Error("deep")` re-raised with `rethrow: {}` reaches the outer catch as `INTERNAL_ERROR` / `"deep"`; a new coded `throw` inside `catch:` logs the caught failure as its `cause`.
- **Rust:** a Rust controller's `data` and `displayMessage` cross the C ABI and the napi bridge.
- **Nothing old left:** no repo file still matches `errorEnvelope`, `"ValidationError"`, `error.text`, a `throws.codes` entry with `message:`, or a client reading `error.code` from a response body.
