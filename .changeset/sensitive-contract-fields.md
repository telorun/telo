---
"@telorun/kernel": minor
"@telorun/analyzer": minor
"@telorun/ide-support": minor
---

`x-telo-sensitive` keeps auth material off the debug wire

Invoke inputs and outputs ride the debug wire on every call under `--inspect` —
which is every watch session — and nothing scrubbed them. The kernel's substring
scrubbing has exactly one call site, the resource-Created event's properties;
log attributes match on exact values; dispatch payloads were not covered at all.

That was survivable while a credential was a held instance whose material never
crossed a dispatch boundary. It stops being survivable the moment auth is a
dispatched `Telo.Invocable`, because the token becomes an invoke **output**.

A contract property may now be marked `x-telo-sensitive: true`, and the trace
payload carries that value as `[redacted]` instead of verbatim. `Http.Credential`
marks its own output, so every implementation — including OAuth's, which was
already on the wire unmarked — inherits it.

Declared by the kind that OWNS the contract, read generically: the kernel names
no kind, and any module opts in, the same shape `x-telo-eval` has. Exempting "an
`Http.Credential` result" directly would have been kind-knowledge in the kernel,
and would have stopped at that one kind while the same token surfaces wherever
else a contract carries it.

The key is kept and only the value replaced, per the logging spec §14 — a payload
that silently loses a key reads as a value that was never produced. Where the
contract cannot be resolved the payload is withheld whole rather than guessed at;
the dispatch that follows raises that same failure with its own code, so nothing
is swallowed.

Completion follows the same split. The annotation vocabulary was offered only
where the fragment is `KindSchema` — a kind's CONFIGURATION — so the editor
suggested `x-telo-sensitive` on the one schema the kernel never reads it from and
withheld it from the two where it is the whole mechanism. It now lives in its own
`TELO_DATA_SCHEMA_ANNOTATIONS` set, offered for `JsonSchema7`.

Bounded by the schema, like the default-fill and scalar-normalization walks
beside it: a contract marking nothing walks nothing at dispatch, and the paths
are resolved lazily so a contract is still compiled on first dispatch rather than
at create time.
