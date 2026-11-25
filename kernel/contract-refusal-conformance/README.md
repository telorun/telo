# Contract refusal conformance vectors

What a kernel refuses a value at an invocation contract with, frozen as data: every kernel that binds contracts reads `vectors.json` and answers each row identically — the code, the whole message and the whole `data`.

## The refusal

A value a bound contract refuses — a call's inputs against `inputType`, a result against `outputType` — is `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID`, its message `<target>: inputs do not satisfy the declared inputType: <detail>` (`result do not satisfy the declared outputType` for a result), and its `data` `{ issues }`, one issue per refusal in the value-issue vocabulary:

- `pointer` — the refused value's place, as a JSON Pointer;
- `keyword` — `required` (params `missingProperty`), `format` (params `format`, a value type's name) or `invalid` (no params) for any other keyword;
- `code` — only for a value of a type with members (a `Telo.Url`) that does not build: the type's own code.

A schema refusal's detail is `Invalid value passed: <value>. Error: <sentence>`, the value written as plain JSON — an instant in RFC 3339, a duration as `"5400s"`, bytes as base64url, a value holding a sensitive member as `[redacted]`. A value of a type with members that does not build is refused before the schema is consulted, its detail `<pointer>: <code>: <reason>`, and never quotes the value.

## A row

```json
{ "id": "…", "direction": "inputType", "schema": {}, "value": {}, "expect": { "code": "ERR_INPUT_INVALID", "message": "…", "data": { "issues": [] } } }
```

- `direction` — `inputType` (the value is a call's inputs) or `outputType` (the value is what the target returned).
- `schema` — the contract, written inline on the resource.
- `value` — the value, typed frames (`{"$telo": "google.protobuf.Timestamp", "value": "…"}`) as in the schema-validation vectors.
- `expect` — the refusal; `data` is `null` when the refusal carries none.

The target every row is bound under is `target`, `Fx.Target/probe`.

## Runners

- `kernel/nodejs/tests/contract-refusal-conformance.test.ts` — the Node kernel, through `resolveBoundContract` and `bindContract`.
- `kernel/rust/tests/contract_refusal_conformance.rs` — the Rust kernel, through its invocation contract; a value crosses that kernel's dispatch as plain JSON, so each typed frame is written in its type's plain encoding first.

Each runner pins how many rows it answers and checks every row's keys.
