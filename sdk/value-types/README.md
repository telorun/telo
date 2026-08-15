# Value types

One JSON file per value type, read as one lexically ordered set. A **value type**
is what `x-telo-type` names in a schema node: what the value at this slot is,
beyond what JSON Schema's `type` vocabulary can say.

The files live **here**, beside the language halves rather than inside either,
because every runtime that hosts Telo needs the identical vocabulary — the Rust
half resolves `!include-bytes` into a `Telo.Bytes` slot in a kernel with no CEL
engine anywhere near it. A registry written as one language's code would be a
second registry, hand-copied, drifting silently. JSON because it is the only
format all three runtimes embed with no generation step: Rust has `include_str!`,
Go has `//go:embed`, TypeScript has neither and only `resolveJsonModule`.

`scripts/copy-value-type-entries.mjs` (the SDK's `prepare`) copies them into
`sdk/nodejs/src/value-types/entries/` and emits the barrel from the same
directory listing, so a file that exists always loads — a hand-maintained list is
the one place this mechanism could fail silently.

## An entry

An entry declares **how the value is represented** and nothing about any runtime.

| key              | meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `name`           | `Telo.`-qualified. The closed vocabulary an author writes at the name slot.    |
| `representation` | `json` — an ordinary value; or `instance` — not JSON at all.                   |
| `base`           | `json` only: the JSON Schema type the name refines. The schema still validates. |
| `binding`        | `instance` only: a stable symbolic key each runtime maps to its own identity.  |
| `live`           | An instance whose consumption has effects, so it is exempt from validation.    |
| `parameters`     | Named type parameters. Each is optional and defaults to *any*.                 |
| `description`    | What `telo cel types` and the generated docs section print.                    |

`binding` is deliberately **not** a constructor name — that is a fact about one
language. Each runtime carries a binding table (`sdk/nodejs/src/value-type.ts`,
`sdk/rust/src/value_type.rs`) mapping the key to its own identity. A `binding`
with no row in the host's table is a **hard startup error**, never a skipped
assertion: a type that cannot be asserted would silently exempt every slot that
declares it.

Adding a value type is one file here plus one row per runtime that can represent
it. A **representation** cannot be module-defined — it needs code plus a binding
row — while a **shape** can, as an ordinary `Telo.JsonSchema` resource named by
`!ref`.
