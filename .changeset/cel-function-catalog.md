---
"@telorun/cel": minor
---

`@telorun/cel` carries Telo's **function catalog** — the dialect a manifest is written in — as signature
data plus implementations, so the engine holds the whole function surface an expression may call.

`registerFunctionCatalog(environment, { handlers })` registers 67 functions over 86 signatures through the
**public** `registerFunction`, with no privileged path of any kind: a host may leave the catalog out,
replace a function, or remove a name, and a default environment has none of it.
`src/signatures/function-catalog.json` is the declarations — every signature, the category and summary a
listing prints, and whether a function is deterministic, host-backed or guards its literal arguments — and
`functionCatalog()` is the one surface a `functions` listing reads, so a consumer never reconstructs it
from registrations. Not one function in it is defined by cel-spec, which the file declares once rather
than on each entry; the validator (`check:signatures`) refuses an entry that redeclares it, a signature
with no implementation, and any signature answering the same call as a standard one — which registering it
would silently replace.

**Nine functions are the host's**: `sha256`, `md5`, `sha1`, `sha512`, `hmac`, `base64Encode`,
`base64Decode`, `json` and `joinPath`, each needing a facility the package may not reach. One left out
still registers, so a consumer that only ever checks still type-checks the call, and evaluating it answers
an `unbound_function` error **naming the function** rather than a null or an empty string.

**A refusal is the catalog's own words** — `<function>: <what is wrong>`, identical on every engine and
never a library's or the host language's wording: an invalid pattern ends with one of RE2's own
parse-error kinds and nothing after it, and `parseJson` words its own offset
(`parseJson: invalid JSON at offset 3`). **And a refusal over a literal argument is now the CHECKER's**:
a registration may carry a `checkArguments` guard (`LiteralArgumentCheck`), asked where the call resolves
and reported as `CEL_INVALID_ARGUMENT` naming the call as written, so `fixed(1.0, 11)` is refused without
running the expression. Twelve catalog functions carry one, and each runs the very code the evaluation
runs, so the static and dynamic answers cannot drift.

`string(timestamp)`, `string(duration)` and `int(timestamp)` are **not** in the catalog: all three are
cel-spec's own and the standard library declares them, with the same call form, arity and return type.

The catalog's behaviour is pinned by the conformance vectors, replayed in place: `catalog.json`'s 178 rows
and `types.json`'s 26, every row answered or corrected against a cited authority, with 52 refusals and 28
literal-guard diagnostics reproduced byte for byte — and both backends are now held to each other over
every one of the 300 calls the registry holds, the catalog's 86 included.

Three runtime dependencies, each pinned exactly because the vectors pin their answers: `re2js`,
`d3-format` and `uuid`.
