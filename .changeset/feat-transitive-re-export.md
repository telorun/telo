---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

feat(kernel,analyzer): transitive re-export of exported instances and kinds

A `Telo.Library` may now re-export both an instance and a kind it reaches through one
of its own imports, using plain dotted names (the `!ref` tag is not allowed in
`exports.resources`):

```yaml
exports:
  resources:
    - Migrate            # export a locally-owned instance
    - Domain.Db          # re-export the instance reached via this lib's `Domain` import
  kinds:
    - Greeting           # export a locally-defined kind
    - Domain.Thing       # re-export a kind imported from `Domain`
```

A consumer importing the library as `Api` then references `!ref Api.Db` /
`kind: Api.Thing`. Re-export composes to arbitrary depth (`app → api → domain → …`)
because each hop just re-declares `<PrevAlias>.<Name>` / `<PrevAlias>.<Kind>`,
and resolution stays O(1) regardless of depth: each import builds flattened export
tables that copy the owner's terminal getter / canonical kind by reference, so a
lookup never walks the chain. The analyzer forwards re-exported instances and kinds
transitively (fixpoint over the import graph) so `telo check` resolves them too,
keeping static analysis and runtime in agreement, and the `exports.kinds` gate still
rejects kinds that aren't re-exported. Bare-string `exports.resources` entries keep
working as local exports.
