---
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/templating": minor
"@telorun/kernel": minor
---

Value types can declare which of their type parameters is the **element** — what
iterating a value of that type yields. `Telo.Stream`'s `of` is the first entry to
carry it, and the Rust reader accepts the key so both runtimes keep reading the
identical vocabulary.

The analyzer consumes that rather than naming a type: `x-telo-context-element-from`
resolves an element as an array's `items`, else the argument bound to whichever
parameter the resolved value type declares as its element. It also resolves the
collection chain through a kind's declared `inputType`, not just the legacy
`inputs:` property map — without which `item` was silently untyped in every kind
that declares a contract. A new `x-telo-context-collection-from` types a binding
that names the collection itself and withholds it when the resolved type is
`live`, since re-exposing a cursor a consumer is draining is unsafe.

`checkSchemaCompatibility` and `celTypeSatisfiesJsonSchema` now distribute over
union branches instead of returning compatible the moment either side is one — a
mismatch is reported only when no source-branch/target-branch pair agrees. A
union used to switch both checks off by construction, which is exactly what a
slot admitting several shapes needs them for.

A union-typed slot can now hold a whole-field CEL expression at all. Both
placeholder paths — `celPlaceholderForSchema` and the kernel's twin in
`schema-compiled-values.ts` — handed such a leaf a stand-in no branch accepts,
so a field declared `anyOf: [array, boolean]` was statically and dynamically
unwritable as an expression; a slot whose union happened to contain a `live`
branch escaped only by accident. Both now take the first branch that yields a
placeholder, and the kernel resolves which branch a value was written against
through the analyzer's newly exported `selectUnionBranch`, so the static and
dispatch halves cannot disagree.

CEL gains `slice(sequence, start, end)` over strings, bytes and lists, plus
`bytesFromBase64` / `bytesToBase64`. The existing `base64Encode` / `base64Decode`
keep their UTF-8 string-to-string meaning and are documented as text-only.
