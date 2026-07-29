---
"@telorun/http-client": patch
"@telorun/analyzer": patch
---

Fix a credentialed request losing the content-type derived from its body.

The credential path rebuilt the header set from the client and request maps, but
the `content-type` inferred for an object body was mutated into the merged map
only — so every POST/PUT with a JSON body through a client carrying a credential
was sent with no content-type, and arrived unparsed. Derived headers are now kept
separately and filled in last, only where nothing else set the key.

The analyzer's sentinel pass reads `x-telo-scope` from the declaring kind's field
map instead of inferring a scope structurally from any array of named inline
resources. The heuristic happened to coincide with `Run.Sequence.with` today, but
this pass is shared with the kernel, so it would have baked a guess into the
runtime manifest tree the first time a kind carried such an array without being a
scope.
