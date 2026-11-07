---
status: draft
priority: medium
depends-on: []
packages: [sdk/builtins, analyzer/nodejs, analyzer/rust, kernel/nodejs, kernel/rust, modules/run, tests, docs, apps/authoring-agent, apps/hub]
---

# `Telo.Value`: value shaping as a built-in kind

## Problem

`Run.Value` is the standard way to return a CEL-shaped value from an invocable: a handler that maps fields, joins strings or returns a constant. It is one of the most used kinds in the repo (651 declarations in 422 tracked manifests), and in 186 of those files it is the only `run` kind, so the `Run` import is there just for it.

Its companion pieces are already built in. `Telo.Sequence` (moved out of `run`, with `Run.Sequence` left as a deprecated twin) hosts the step grammar, the step grammar's `value` step shapes a value inside a sequence, and `Telo.Function` is a built-in CEL-bodied callable. Only the standalone CEL-bodied invocable still needs an import.

## Solution

Add `Telo.Value` to the built-in vocabulary (entry `Value`): a `Telo.Invocable` with exactly `Run.Value`'s surface (`inputType`, `outputType`, `bindings`, `value`, with `value` required). Its semantics are unchanged: bindings are read by bare name, ordered by what they reference and computed at most once per call. `value` is any shape (object, list, scalar or constant) evaluated over `inputs` and the bindings. `outputType` checks `value` statically and the result at every call. Its controller is the kernel's and evaluates through the same SDK binding and value expansion `Run.Value`'s controller uses, so the two kinds cannot answer differently. It needs no import, ships in the `Telo.Builtins` archive, is printed by `telo builtins Value` and is listed by the hub as a built-in. Its `metadata.description` is written for hub search: mapping fields, building a response body, returning a constant.

`Run.Value` stays and keeps its own controller. It gains `metadata.deprecated` (reason: identical to the built-in `Telo.Value`, which needs no import; `replacedBy: Telo.Value`), so declaring one is a `DEPRECATED_KIND` warning at the use site. The `run` library description drops "pure value shaping with CEL". Because `replacedBy` names a kind an older analyzer does not know, `run`'s own `requires: telo:` rises from `>=0.128.0` to the release that carries `Telo.Value`, as it did for `Telo.Sequence`.

The Rust kernel refuses `Telo.Value` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`, saying it does not evaluate CEL yet. That is how it refuses `Telo.Sequence`, and it cannot host `Run.Value` today either.

Documentation follows the kind. The `Run.Value` reference and its bindings section move into the "Composing behaviour" guide beside `Telo.Sequence`. The `run` README and docs point there. The authoring primer, the hub guide `design-library` and every docs example that declares a value write `Telo.Value`. In-repo manifests are not rewritten in bulk: each switches when it is next edited, and gets a `requires: telo:` floor then.

## Decisions

- **Name `Telo.Value`.** It matches the step grammar's `value` step and the kind's own `value` field, so the standalone form and the in-sequence form read as one concept.
- **No manifest migration, only deprecation.** This follows the `Run.Sequence` precedent: the old kind is still correct, and a migration would leave every rewritten file with an unused `Run` import that a rename cannot safely remove.
- **Same shape, no redesign.** Both kinds keep working side by side during the transition, so a file switches by changing its `kind:` line, dropping the `Run` import when nothing else uses it, and adding the floor.
- **Not folded into `Telo.Sequence`.** A sequence is a Runnable whose `outputs` is a map and which has no `bindings`. Widening it to return any shape would make one kind do two jobs.
- **No benefits-ledger entry.** No new feature reaches authors, only one fewer import.
- **Release bookkeeping.** One changeset for the telo version line (sdk, analyzer, kernel, which move together). One `Deprecated` fragment for `run`, added with `telo release add`.

## Examples

Before: a route handler shaped by `Run.Value`, which needs the `run` import.

```yaml
kind: Telo.Application
metadata: { name: HelloApi, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.42.0#sha256-wF3AHGL8hGFdy7SfxXJkaXtRzLeqKtgqTVmN9anXKTk
  Run: oci://ghcr.io/telorun/run@0.32.0#sha256-4BOwkyKZuEAr-gDIkQWEzA1UszTNrIGHyv9GFnnUkv8
targets: [!ref server]
ports: { http: { env: PORT, default: 8845 } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /v1, mount: !ref helloApi }
---
kind: Http.Api
metadata: { name: helloApi }
routes:
  - request:
      path: /hello
      method: GET
      schema:
        query: { type: object, required: [name], properties: { name: { type: string }, title: { type: string } } }
    handler:
      kind: Run.Value
      inputType:
        kind: Telo.JsonSchema
        schema: { type: object, required: [name], properties: { name: { type: string }, title: { type: string } } }
      outputType:
        kind: Telo.JsonSchema
        schema: { type: object, required: [greeting, length], properties: { greeting: { type: string }, length: { type: integer } } }
      bindings:
        greeting: !cel "'Hello ' + addressed + '!'"
        addressed: !cel "has(inputs.title) ? inputs.title + ' ' + inputs.name : inputs.name"
      value:
        greeting: !cel "greeting"
        length: !cel "size(greeting)"
    inputs:
      name: !cel "request.query.name"
      title: !cel "request.query.title"
    returns:
      - status: 200
        content:
          application/json:
            schema: { type: object, required: [greeting, length], properties: { greeting: { type: string }, length: { type: integer } } }
            body: !cel "result"
```

```shell
$ telo check telo.yaml
telo.yaml:24:13  warning  DEPRECATED_KIND  Kind 'Run.Value' is deprecated: Identical to the built-in Telo.Value, which needs no import. Use 'Telo.Value' instead.

1 warning
```

After: the same application with the built-in. The `Run` import is gone, the handler's `kind:` changes, and the floor names the release carrying `Telo.Value` (`0.130.0` stands for the pending `TELO_SURFACE_VERSION` when the change is written).

```yaml
kind: Telo.Application
metadata: { name: HelloApi, version: 1.0.0 }
requires: { telo: ">=0.130.0" }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.42.0#sha256-wF3AHGL8hGFdy7SfxXJkaXtRzLeqKtgqTVmN9anXKTk
targets: [!ref server]
ports: { http: { env: PORT, default: 8845 } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /v1, mount: !ref helloApi }
---
kind: Http.Api
metadata: { name: helloApi }
routes:
  - request:
      path: /hello
      method: GET
      schema:
        query: { type: object, required: [name], properties: { name: { type: string }, title: { type: string } } }
    handler:
      kind: Telo.Value
      inputType:
        kind: Telo.JsonSchema
        schema: { type: object, required: [name], properties: { name: { type: string }, title: { type: string } } }
      outputType:
        kind: Telo.JsonSchema
        schema: { type: object, required: [greeting, length], properties: { greeting: { type: string }, length: { type: integer } } }
      bindings:
        greeting: !cel "'Hello ' + addressed + '!'"
        addressed: !cel "has(inputs.title) ? inputs.title + ' ' + inputs.name : inputs.name"
      value:
        greeting: !cel "greeting"
        length: !cel "size(greeting)"
    inputs:
      name: !cel "request.query.name"
      title: !cel "request.query.title"
    returns:
      - status: 200
        content:
          application/json:
            schema: { type: object, required: [greeting, length], properties: { greeting: { type: string }, length: { type: integer } } }
            body: !cel "result"
```

The bindings are written in reverse order of use on purpose: `greeting` reads `addressed`, so `addressed` is computed first whatever the order they are written in.

The definition is printed like every other built-in:

```shell
$ telo builtins Value
kind: Telo.Definition
metadata:
  name: Value
  description: Returns a value shaped from its inputs — mapped fields, a built response body, joined text or a constant — with optional named intermediate values. Declares the input and result types it is checked against before it runs and at every call.
capability: Telo.Invocable
schema:
  type: object
  properties:
    inputType: { title: Input Type, x-telo-ref: { kind: Telo.Type, use: schema } }
    outputType: { title: Output Type, x-telo-ref: { kind: Telo.Type, use: schema } }
    bindings:
      title: Bindings
      type: object
      additionalProperties: true
      propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }
      x-telo-context:
        type: object
        x-telo-bindings-from: bindings
        properties: { inputs: { type: object, x-telo-context-from: inputType } }
    value:
      title: Value
      x-telo-context:
        type: object
        x-telo-bindings-from: bindings
        properties: { inputs: { type: object, x-telo-context-from: inputType } }
      x-telo-value-schema-from: outputType
  required: [value]
  additionalProperties: false
```

`outputType` is held against `value` before anything runs. Had `length` been written `!cel "greeting"`, the check refuses it:

```shell
$ telo check telo.yaml
telo.yaml:36:17  error  CEL_TYPE_ERROR  'value.length' is declared integer by outputType, but the expression is string

1 error
```

The Rust kernel hosts an application whose only targets are inline invoke steps, so this is the smallest one it would read, and it refuses the `Telo.Value` in it at load, worded as its `Telo.Sequence` refusal is:

```yaml
kind: Telo.Application
metadata: { name: Greet, version: 1.0.0 }
requires: { telo: ">=0.130.0" }
targets:
  - { name: greeting, invoke: !ref greet, inputs: { name: telo } }
---
kind: Telo.Value
metadata: { name: greet }
inputType:
  kind: Telo.JsonSchema
  schema: { type: object, required: [name], properties: { name: { type: string } } }
value: !cel "'Hello ' + inputs.name"
```

```shell
$ telo run telo.yaml
error: [ERR_UNSUPPORTED_MANIFEST_FEATURE] resource 'greet' declares `Telo.Value`; this kernel does not evaluate CEL yet
```

## Verify

- `telo builtins Value` prints the definition, in both CLIs, and the hub lists `Telo.Value` as a built-in.
- A new `tests/telo-value.yaml`, with no `imports:`, covers object, list and scalar results, bindings, an `inputType` default and `ERR_INPUT_INVALID`, `ERR_OUTPUT_INVALID` against `outputType`, and a static `outputType` mismatch reported by `telo check`.
- A manifest declaring `Run.Value` still runs unchanged, and `telo check` warns `DEPRECATED_KIND` naming `Telo.Value`. The existing `run` tests pass as they are.
- The Rust kernel refuses a `Telo.Value` declaration with `ERR_UNSUPPORTED_MANIFEST_FEATURE` (a cargo test).
- The floors work, each checked by execution against the previous published CLI. A manifest declaring `Telo.Value` with its `requires:` block stripped is rejected (`UNDEFINED_KIND`), and with the block back reports `MODULE_REQUIRES_NEWER_RUNTIME`. The same holds for `run`'s own `telo.yaml` with its raised floor.
