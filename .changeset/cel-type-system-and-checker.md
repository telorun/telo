---
"@telorun/cel": minor
---

`@telorun/cel` gains its registry and its type checker.

**Nothing in the registry is privileged.** The standard library registers through the surface a host
uses, the dispatch key is a call's name, form and parameter types rather than its return type, and
removal is by the same key — so a host can replace `duration(string)` with a signature of its own, or
remove a standard function and have a call to it report `CEL_UNKNOWN_FUNCTION`. An environment clones,
inherits everything and then diverges. The library itself is data (`src/signatures/standard-library.json`,
documented and validated by `check:signatures`), because a port in another language must inherit the same
surface rather than re-type it.

**JSON Schema is the checker's native input, read to full depth**: nested objects, element types, and
unions carried as unions rather than collapsed, so a typo two levels into a schema-typed variable is a
ranged `CEL_UNKNOWN_FIELD`. A flat field map is still accepted, so a host can type exactly as shallowly
as it must. A schema is converted once per registration, so checking does not get more expensive as a
schema gets deeper.

**A named type is not its base.** `registerType` registers a name over a base with its own operators,
comparisons, conversions, members and invariant type parameters; a plain value of the base is refused at
its slot, and a differing type argument is `CEL_TYPE_ARGUMENT_MISMATCH`. A host's vocabulary enters
through that and through one schema resolver, consulted at every schema node before the structural rules.

**Every verdict is decided by the checker, with a source range**, and nothing reads another component's
message: `CEL_SYNTAX_ERROR`, `CEL_TYPE_ERROR`, `CEL_UNKNOWN_IDENTIFIER`, `CEL_UNKNOWN_FIELD`,
`CEL_UNKNOWN_FUNCTION`, `CEL_WRONG_CALL_FORM`, `CEL_TYPE_ARGUMENT_MISMATCH`, `CEL_NULLABLE_ACCESS`,
`CEL_INVALID_ARGUMENT`, and `FUNCTION_UNRESOLVED` / `FUNCTION_ARITY_MISMATCH` /
`FUNCTION_ARGUMENT_MISMATCH` for a namespaced call. A fix is a whole-source replacement. Nullable-access
guards are exactly `?:`, `&&` and `||`. A tree resolved under one namespace set and checked against
another is refused with `namespaces_mismatch` rather than checked.

The library is **CEL's**, held to cel-spec rather than to any engine's behaviour: the conversions
(`int(uint)`, `int`/`string` of a timestamp or a duration, the identity conversions), ordering over every
scalar type including bytes, a concatenation whose element type is the one both sides hold, `has()` over
any member read, an unresolved type parameter behaving as `dyn` wherever it is used, and the optional
library whole — `.?`, `[?]`, `of`, `none`, `ofNonZeroValue`, `hasValue`, `value`, `or`, `orValue`,
`optMap`, `optFlatMap`, equality over optionals and `optional_type`. A declaration CEL itself does not
define carries `"spec": false` with a required reason, which the validator gates in both directions;
eleven do.

The grammar closes its cel-spec corners too, each of which the engine being replaced refuses: a **member
name between backticks** (`request.headers.`` `content-type` ``) typed against a schema's `properties`
exactly as a plain member is — without it, every dashed or dotted key in a header map, a JSON payload or a
column set is unreachable by the type checker; **raw bytes literals** (`br`, `bR`, `Br`, `BR`; `rb` is not
one); **`[?x]` and `{?k: v}`** under `enableOptionalTypes`, the entry holding an `optional<T>` and
contributing a `T`; a **double that begins with its point** (`.99`); and an **absolute name** (`.y`),
resolved against the environment's declarations and never against a name the expression bound — the only
spelling for an outer name where a comprehension variable shares it. A **dotted declaration is one name**,
the longest prefix winning: declare `a.b.c`, or `a.b`, or both, and `a.b.c` reads whichever the host
declared.

Also: the per-call resolved-signature listing carrying determinism, host-backedness and throws — derived
from the checker's lowering, so a macro is not listed — and a query for whether a type converts to text.

Still nothing consumes it: `@marcbachmann/cel-js` serves the whole repository, and no manifest, consumer
or module changes.
