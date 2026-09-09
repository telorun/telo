---
"@telorun/analyzer": patch
---

`NAME_CASE_CONVENTION` no longer fires on a named shape whose kind inherits
`capability: Telo.Type` rather than declaring it.

Which half of the naming convention a resource name falls under is decided by its kind's
capability: a `Telo.Type` resource names a shape, so PascalCase is correct for it, and
everything else names a value. That decision read the leaf definition's own `capability:`
field — but capability is inherited and immutable along `extends`, so a kind that omits it
to take its ancestor's answered `undefined` and fell through to value level.

`Type.JsonSchema` is exactly that kind: a pure alias of the kernel built-in
(`extends: Telo.JsonSchema`, no `capability:` of its own). So a shape declared through the
deprecated spelling was reported as miscased while the identical declaration written as
`kind: Telo.JsonSchema` was not — and acting on the report is worse than the warning,
because `extends:` between two named shapes is not a reference slot and so does not move
with the name: renaming the shape silently severs the inheritance and changes what its
children declare.

The fix reads the inherited capability through `inheritedCapability`, the resolver
`validate-extends` and the kernel's definition controller already share, so all three agree
about which capability a kind has. The chain is walked with the module-scoped definition
resolver, because an `extends` alias belongs to the file that declared it and a chain
crossing module boundaries has to re-scope at every hop.
