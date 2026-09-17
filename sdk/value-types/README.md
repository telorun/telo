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
| `celType`        | `json` only, optional: the CEL type a value carries when JSON Schema cannot name it. |
| `binding`        | `instance` only: a stable symbolic key each runtime maps to its own identity.  |
| `encoding`       | Non-live `instance` only, required: the symbolic name of the one plain JSON form. |
| `live`           | An instance whose consumption has effects, so it is exempt from validation.    |
| `parameters`     | Named type parameters. Each is optional and defaults to *any*.                 |
| `description`    | What `telo cel types` and the generated docs section print.                    |

`binding` is deliberately **not** a constructor name — that is a fact about one
language. Each runtime carries a binding table (`sdk/nodejs/src/value-type.ts`,
`sdk/rust/src/value_type.rs`) mapping the key to its own identity. A `binding`
with no row in the host's table is a **hard startup error**, never a skipped
assertion: a type that cannot be asserted would silently exempt every slot that
declares it.

A `json` entry without `celType` is a **nominal brand**: its CEL type is its own
name, degrading to `base`'s CEL type where a slot declares no brand
(`Telo.TcpPort`). With `celType` it is no brand — its values carry that CEL type
itself. `uint` over `integer` is the only such pair (`Telo.Uint64`): its JSON form
is an ordinary integer, and a declared output normalizes to a CEL `uint` the way
an `integer` output normalizes to an int64. A plain number is exact only up to
2^53 − 1, so a wider one is refused at a `Telo.Uint64` slot (the literal
`18446744073709551615` already reads as 2^64); write it as a CEL uint,
`!cel "18446744073709551615u"`.

## Plain encodings

`encoding` names the canonical JSON form of an instance, as a symbol each runtime
maps to its own codec (`PLAIN_ENCODINGS` in `sdk/nodejs/src/plain-encoding.ts`).
Every non-live instance declares exactly one; a `live` one declares none, because
it is never serialized. An encoding with no codec in the host is a hard startup
error.

| encoding       | written as                          | read                              |
| -------------- | ----------------------------------- | --------------------------------- |
| `base64url`    | base64url without padding           | the same form                     |
| `rfc3339`      | RFC 3339 in UTC with a trailing `Z` | RFC 3339 with any offset          |
| `cel-duration` | seconds with an `s` suffix (`5400s`) | any CEL duration string (`1h30m`) within ±315576000000s |

`cel-duration` is not the grammar of the string duration fields many kinds still
declare, which a controller reads with the SDK's `parseDurationMs`: that one reads
a single number and unit and accepts days (`30d`), where CEL's grammar reads
`1h30m` and has no `d`. Moving such a field to `Telo.Duration` changes which
literals it accepts, so it is a breaking change for the kind.

A value is decoded from its encoding only where it arrives from outside, and at
exactly the sites `kernel/specs/invocation-contract.md` §4.6 lists: a literal at a
resource's own config slot, an Application `variables:` / `secrets:` env var or
its `default:`, and a literal at any slot typed from elsewhere — a call's
argument map (a step's `inputs:`, a reference slot's `inputs:` pointer, a
template's top-level `inputs:`, a boot target's inline step), an
`x-telo-schema-from` slot, an `x-telo-value-schema-from` row. One reader
enumerates those sites for `telo check` and for the kernel alike
(`analyzer/nodejs/src/derived-slots.ts`), so the two never disagree about which
value is read against which schema. Everywhere else the slot holds the instance
in both directions: a computed value must already be one, an embed's text is
never decoded, and anything else written there is refused. A transport decodes the
same way when a request arrives, against the schema its route declares.

Where a value is WRITTEN for a reader outside Telo — a transport body, a log
line, a debug-wire payload, a CLI document — it is written in this plain form
keyed on the value, never type-tagged (`writePlainJson` / `toPlainJson` in
`sdk/nodejs/src/plain-json.ts`; `kernel/specs/invocation-contract.md` §4.7). A
reader that is a Telo runtime — the durable journal, a remote step, the function
C ABI — gets the typed frame instead, whose tagged payloads are these same
encodings (`kernel/specs/durable-execution.md` §6). In Rust the instance types are
`Timestamp`, `Duration`, `Bytes` and `Uint64` in `telorun-sdk`, whose serde impls
write the plain form and read either.

Adding a value type is one file here plus one row per runtime that can represent
it, and a codec row when it names a new encoding. A **representation** cannot be
module-defined — it needs code plus a binding row — while a **shape** can, as an
ordinary `Telo.JsonSchema` resource named by `!ref`.
