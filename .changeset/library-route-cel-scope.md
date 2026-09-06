---
"@telorun/analyzer": minor
---

A library's own CEL is typed against the kind its own alias resolves to, so `request` / `result` inside a route an imported library declares no longer read as unknown identifiers — in `telo check` and in an editor alike.

An application analysis is flattened, so an imported library's resources are checked in the consumer's pass — but the kind on such a resource (`kind: Http.Api`) is written in the alias scope of the module that DECLARED it. Resolving it through the entry's aliases alone found no definition, and every binding the kind's `x-telo-context` regions provide went missing: a route's `inputs:` and `returns:` were reported as unknown-identifier errors, anchored on a library file the consumer cannot edit, and the only way out was importing the transport in a manifest that never mentions it.

The rule now has one reader instead of six copies and one omission. The omission was the CEL scope query — the way an editor asks what a site sees — so completion, hover, go-to-declaration and colouring resolved no definition for exactly the manifests the checker had started accepting. A completion list is a claim that the name it offers will pass `telo check`, so the two resolve a kind identically or neither answer can be trusted.

Go-to-declaration on a context binding also carries the declaring module, and resolves a kind two libraries both declare to the right one — a definition name is unique inside its module and not across a flattened set, so matching by name alone landed on whichever document came first.

Also adds `CONTRACT_NOT_SUBSTITUTABLE`: a definition that replaces the `inputType` / `outputType` declared by an ABSTRACT it extends must still stand in for it. Contracts resolve to the nearest declaration in both halves, so a child that declares its own was compared against its abstract by nothing — not the analyzer, not dispatch — and an abstract could state a floor for its implementors that held only for the implementations declaring nothing. Extending a concrete kind is untouched: `base:` and `inputs:` / `result:` exist to reshape a call signature there, and a direction the child bridges is skipped for the same reason.
