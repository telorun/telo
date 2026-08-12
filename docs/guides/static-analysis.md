---
description: "What telo check finds before your application runs — unknown kinds, broken references, CEL type errors — what it cannot see, and how to debug the rest."
---

# Catching errors before they run

A Telo manifest is data, not code, so the whole application can be examined
without starting it. That is not a side benefit — it is the property the design
protects hardest, and it changes what your feedback loop looks like.

```bash
telo check ./manifest.yaml
```

```
manifest.yaml:19:20  error  Run.Sequence/Main: CEL at 'steps[1].inputs.output':
                            'steps.Make.result.mesage' is not defined (available: message)  CEL_UNKNOWN_FIELD

1 error
```

A misspelled property, caught without a database, a network, or a running
process — and the message lists what *was* available.

## What gets checked

The analyzer resolves every import, walks the resource graph, and verifies:

| Category | Examples |
| --- | --- |
| **Kinds** | The kind exists; the module actually exports it; `extends` targets resolve; capability rules hold. |
| **References** | Every `!ref` resolves, and the resource it names is a kind that slot accepts. |
| **Schemas** | Each resource matches its kind's JSON Schema — kind schemas are closed, so a misspelled field is an error, not silently ignored config. |
| **CEL** | Every expression parses, every property exists on the value at that path, nullable values are guarded, and expressions only appear in fields that are actually evaluated. |
| **Contracts** | Call-site `inputs:` satisfy the target's declared `inputType`; a child that replaces a contract bridges it. |
| **Lifecycle** | Observed state (`resources.x.status.y`) is not read in a field that resolves before anything has run. |
| **Modules** | No duplicate import aliases, no incompatible major versions of the same module, exports well-formed. |

All of it is derived from the schemas kinds declare — the analyzer hardcodes
knowledge of no specific kind, which is why a kind you write yourself is checked
exactly as thoroughly as `Http.Server`.

## What it cannot catch

Worth knowing so you calibrate what "no issues found" means:

- **Wrong logic that type-checks.** `!cel "inputs.a - inputs.b"` when you meant
  `+` is a perfectly valid expression.
- **Anything inside a script.** `JavaScript.Script` bodies are opaque — one more
  reason to prefer composition over scripting.
- **The outside world.** Whether your database is reachable, your credentials
  work, or an upstream returns the shape it promised.
- **Runtime data.** The contract is enforced at dispatch, so a violation is a
  clean `ERR_INPUT_INVALID` — but it is found when the call happens.

Those are what [tests](/build/testing) are for.

## The loop

**1. In the editor.** The [VS Code extension](/build/vscode) runs the same
analyzer as you type, with completions and go-to-definition driven by the same
schemas. This is where most errors should die.

**2. Before running.** `telo check ./manifest.yaml` — accepts several paths, a
directory containing a `telo.yaml`, or an HTTP(S) URL, and resolves a shared
module once across all of them.

**3. In CI.** `telo check` exits non-zero when there is at least one error
(warnings alone do not fail it), so it works as a PR gate with no wrapper:

```yaml
- run: telo check ./apps/my-app/telo.yaml
```

Because imports resolve through the same cache `telo run` uses, a fully pinned
manifest needs no network at all on a repeat check.

For a tool rather than a person, `-o json` turns stdout into a single document
and leaves stderr for the human-readable notes:

```bash
telo check -o json ./apps/my-app/telo.yaml
```

```json
{
  "ok": false,
  "errorCount": 1,
  "warnCount": 0,
  "diagnostics": [
    {
      "file": "apps/my-app/telo.yaml",
      "line": 12,
      "column": 5,
      "severity": "error",
      "code": "CEL_UNKNOWN_FIELD",
      "message": "Unknown field 'titel' on request.body"
    }
  ]
}
```

Branch on `code`, not on the message — the codes are stable, the wording is not.
The exit code is unchanged, so the same command still works as a gate. Nothing is
coloured on stdout in this mode, whatever `FORCE_COLOR` is set to.

**4. When you run it.** `telo run` performs the *same* analysis during load and
refuses to start if it fails — you get the identical message and nothing
initializes. `telo check` is that gate, earlier and with no side effects.

## Reading a diagnostic

```
manifest.yaml:14:5  error  No Telo.Definition found for kind "Http.Srver".  UNDEFINED_KIND
```

`file:line:column`, severity, message, code. Search the
[diagnostics reference](/reference/diagnostics) for the **code** — the message
contains your resource names, the code is stable.

Errors fail the command; warnings do not. There are only four warnings, and each
one flags something suspicious rather than broken — an unused declaration, a
deprecated ref form, a version hoist, a capability that shadows an abstract.

## When a CEL expression will not type-check

Three questions, in order:

1. **Is the field evaluated at all?** `CEL_IN_NON_EVAL_FIELD` means the
   expression sits in a field the kind never evaluates — it would be read as a
   literal string. The kind's schema decides this; check it on the
   [hub](https://hub.telo.run).
2. **Is the name in scope here?** `CEL_UNKNOWN_FIELD` names the path it could
   not resolve. Scope depends on *where* the expression is written — the table
   in [`!ref` and `!cel`](/learn/refs-and-cel) lists every name and where it
   exists.
3. **Can it be null?** `CEL_NULLABLE_ACCESS` means the schema admits `null`.
   Guard it: `error != null && error.code`, or a ternary. The classic case is
   `error` inside `finally:`, which is null when the `try:` succeeded.

## Debugging past the analyzer

When it starts but misbehaves:

| Tool | Use it for |
| --- | --- |
| `telo … --verbose` | Verbose kernel logging through boot and dispatch. |
| `telo … --debug` | Writes a `.telo.debug.jsonl` event log next to the manifest — every kernel event in order. Best for "which step ran, with what?". |
| `telo … --inspect` | Starts a live inspection endpoint (default `127.0.0.1:9230`) and opens the UI, holding the app open even when it would otherwise exit. `--no-open` suppresses the browser. |
| `telo … --watch` | Restart on every manifest change while iterating. |

### When init fails

`ERR_RESOURCE_INITIALIZATION_FAILED` reports by **root cause**, not by count.
Resources that never ran because a dependency failed are classified as *derived*
and attributed to the entry that actually broke — so the resource in the
headline is the one to fix, and the list under it is fallout. Failures inside an
imported library are nested under that import rather than flattened into the
parent.

## See also

- [Diagnostics reference](/reference/diagnostics) — every code, with what
  triggers it and how to fix it.
- [`!ref` and `!cel`](/learn/refs-and-cel) — the scope table question 2 refers to.
- [Testing your manifests](/build/testing) — for the errors no analyzer can find.
