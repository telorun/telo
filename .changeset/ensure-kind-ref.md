---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/http-client": minor
"@telorun/http-server": minor
"@telorun/mcp-server": minor
"@telorun/benchmark": minor
"@telorun/run": minor
---

Rename `ctx.resolveChildren` to `ctx.ensureKindRef`. The old name stays as a
deprecated delegate.

The method never resolved anything: it takes a nested slot value — an inline
`{ kind, …config }` definition, a `{ kind, name }` ref, or a `!ref` sentinel —
and produces a `KindRef`, registering the inline case as a manifest (under a
supplied or generated name) on the way. `ensure` carries that create-if-needed
side effect; `KindRef` is what comes back.

It also reads correctly next to `ctx.resolveRef`, which runs the other direction
— ref to live instance. Two `resolve*` methods on one interface returning
opposite categories was the ambiguity; this fixes it at the source rather than
lengthening the name of the method that was right.
