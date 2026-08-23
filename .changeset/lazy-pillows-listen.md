---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

A kind whose `schema:` references a named shape is now actually checked.

Referencing a shape declared elsewhere — `$ref: "telo://Self/<Type>"` at a slot
inside a kind's own `schema:` — went blind in both halves, in opposite ways that
hid each other:

- The analyzer validated resource configuration on an AJV instance where named
  shapes were never registered, so the schema failed to compile and the failure
  was swallowed. `telo check` reported no issues for a resource that was
  arbitrarily wrong, and the kernel — whose validator does resolve the reference
  — rejected it at boot. Configuration is now validated through the definition
  registry, the same instance the compile check already reports through, so
  there is one answer instead of two.
- Every walk that places a stand-in for a CEL expression stopped at the
  reference. A described value read as undescribed, so each expression under it
  was handed the typeless `""` / `null` placeholder and then reported as a
  violation of the very shape describing it — a valid document could not be
  written at all.
- A `$ref` inside the referenced shape resolved against the REFERRING document.
  A shape declares its own vocabulary that way (`anyOf: [{$ref: "#/$defs/Text"},
  …]`), and resolving those against the referrer finds nothing, leaves every
  branch reading as unconstrained, and collapses the union to nothing. The base
  now travels with the schema: `resolveRefIn` reports the root a resolved
  schema's own references resolve against, and both walkers carry it.

Also fixed in union reduction: a branch written as a `$ref` is reported by AJV
under the TARGET's schemaPath, so nothing in such an error points back at the
union that dispatched to it. Branch attribution now falls back to the value node
each complaint is about, which is what reaches a large vocabulary — a branch per
`$defs` entry is exactly how one is written, so the biggest unions were the ones
staying unreduced.

Every site that validates configuration now runs on the registry: a top-level
resource, an inline declaration nested in a step's `invoke:` (which CLAUDE.md
mandates for a single-use resource, so it is the common shape rather than the
exception), and a step's arguments against the invoked kind's declared contract.
The inline validator takes its validator as a REQUIRED parameter rather than
defaulting to one, because a default is a second validator answering the same
question and an omission would stop checking silently.

`resolveRef` and `selectUnionBranch` take an optional resolver for a named
shape; `stripCompiledValues` takes one too. `substituteCelFields` now takes an
options object instead of six positionals — the resolver was the last of them,
so reaching it meant counting `undefined`s, and a caller that stopped one short
got the old blind behaviour with no signal. Two of them had.

Union reduction also indexes its occurrences by value path rather than scanning
every union per error. Reducing a 16-deep nested failure goes from 0.41 ms to
0.066 ms, and stops growing quadratically with depth — it runs on the editor's
per-keystroke path. And where AJV inlines several `$ref` branches under one
identical `schemaPath`, the alternatives are now listed one per missing key
rather than joined into a single phrase that read as one alternative demanding
all of them.
