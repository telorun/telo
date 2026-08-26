---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/templating": minor
---

**A template body is a declaration of its own kind.** CEL inside a
`Telo.Definition`'s `resources:` entry is now resolved through the NESTED kind's
own annotations — its `x-telo-context` regions, its step body, its error branches
— with `self` merged in from the enclosing definition's `schema:`.

It was resolved in the ENCLOSING definition's scope against one fixed permissive
context (`self`, plus open `request` / `result` / `steps` / `error`). So `inputs`
and `item` were undefined wherever the nested kind declares them — a step's
`inputs.bindings` reading the call's own arguments failed as `'inputs' is not
defined`, and an iteration's `item` the same way — while `error` was offered
everywhere regardless of whether a `catch:` was in scope. That is why no standard
library template has a body of more than one dispatch.

- **The kernel stops keying deferral on a name list.** A node survives `init()`
  unexpanded when the nested kind marks its path `x-telo-eval: runtime` or covers
  it with a CEL-bearing region, read through the containment matcher both halves
  already share. The old list — `request`, `result`, `steps`, `error` — had to be
  extended for every name any kind ever binds, and `inputs` and `item` were
  simply absent from it. A deferred node naming only `self` is still resolved at
  `init()`: `self` is fixed for the life of the instance.
- **`self` is bound into the template's child context**, as the published-reading
  view, so a node the nested kind evaluates later can read the enclosing
  resource's configuration beside the call-time names that kind binds. This
  removes the restriction that one expression may not mix `self` with a
  call-time name.
- **`invoke:` / `run:` / `provide:` / `mount:` accept a `!ref`** naming a sibling
  `resources:` entry — the spelling every other reference uses — and a `!ref`
  naming no entry is `TEMPLATE_DISPATCH_UNKNOWN`, with the nearest sibling as a
  fix. A `Telo.Definition` is in both reference-skip sets and these slots carry no
  `x-telo-ref`, so nothing would otherwise resolve them: introducing the tag at a
  slot no reference pass reaches would be worse than the string form it replaces,
  since `!ref` is the one spelling that advertises static resolution. Decidable
  only when every sibling name is literal — a template routinely names entries
  with CEL, and an expression could expand to the referenced name.
- **A nested body's root-anchored bindings resolve against the BODY.** Its
  context scopes were rebased under `resources[i]` but every annotation inside
  them that anchors at a root — `x-telo-context-element-from`,
  `-collection-from`, `-from-root`, `x-telo-bindings-from` — was still resolved
  against the enclosing `Telo.Definition`. So an iteration's `collection:` was
  looked up on a document that has no such field, `item` typed open, and a typo
  below it went unreported: the one place a nested declaration did not answer as
  the same declaration written at the top level. `self` is substituted before the
  annotations run, being the single binding that genuinely belongs to the
  enclosing definition.
- **`x-telo-context-from` navigating a dynamic node types OPEN, not empty.** A
  route whose `request.schema.body` is `!cel "self.model.schema"` declares a body
  whose shape is only known once the template is instantiated; resolving it to
  nothing reported `request.body` as undefined, blaming the reader for the
  writer's dynamism.
- **`getManifestItem` resolves a scope with concrete indices.** It built a regex
  from the scope string, in which `resources[4]` is a character class — so every
  nested scope silently resolved to the whole document instead of the array item,
  and every `x-telo-context-from` beneath one navigated from the wrong root.
- **`precompileDoc` carries `refs` through.** It rebuilds every tagged
  sentinel's compiled value by hand and dropped the AST-derived root identifiers
  the engine had just computed — so `refs` was absent for every `!cel` in every
  manifest, and a consumer asking what an expression READS had nothing but the
  source text to scan. (`!sql` dropped them one level down, for the same reason.)
  That is what a template body's deferral decision needs, and scanning text
  cannot tell an identifier from a word inside a string literal.
- **`collectResourceRefs` stops at anything it has already seen.** A re-created
  resource is rebuilt from the manifest as registered, but Phase-5 injection
  mutated that object in place on the previous pass — so a reference slot can
  already hold a live instance, whose object graph is cyclic, and the walk
  overflowed the stack instead of reporting the init failure that caused the
  re-create.
