---
"@telorun/http-client": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
---

Authenticate HTTP requests through the client, and resolve `!ref` inside a scope.

`http-client` gains an `Http.Credential` abstract and a `credential` slot on
`Http.Client`. A credential is consulted once per request and receives the request
about to be sent — method, URL, headers, query — so a scheme that signs the request
satisfies the same contract as one that adds a bearer token; what it returns is
merged into the outgoing request. A `401` re-invokes it with `forceRefresh: true`
and retries the call once, so every credential type inherits that behaviour rather
than re-expressing it.

The analyzer now types a route's `result` from the referenced handler's **kind**
when the handler instance declares no `outputType`, the same layering
`steps.<name>.result` already applies. A kind with one fixed output shape declares
it once on its `Telo.Definition` and every `returns[].when` reading it is
checked — previously such a handler fell back to an open schema and typos passed.

`ctx.resolveRef` and `resolveInvocableDispatcher` both resolve a `!ref` that
reaches a controller unrewritten inside an `x-telo-scope` array, and resolve a bare
name scope-local first with the enclosing module as the fallback — matching
`ScopeContext.getInstance` and the CEL `resources` layering, so a `with:`-scoped
resource can reference a scoped sibling. `RefResolveContext` gains an optional
`resolveLocalInstance` hook and `DispatchContext` an optional `ensureKindRef`, so
neither resolution path is rescued while the other is not.

The analyzer now applies that same precedence, in both the reference diagnostics
and the Phase 2.5 sentinel rewrite. Previously it resolved a scoped bare name
against the module-level resource while the runtime bound the scope-local one, so a
shadowed name could type-check against a resource that never runs (or be reported
as a kind mismatch naming one).
