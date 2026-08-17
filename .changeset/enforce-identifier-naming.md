---
"@telorun/analyzer": minor
---

Every author-written name is now checked, and the convention behind it is stated
in one sentence: **case encodes what a name denotes.** PascalCase names a type —
a module `metadata.name`, a kind name, an import alias, or a resource whose
capability is `Telo.Type`. camelCase names a value — a resource instance, a `Run`
step, a `variables:` / `secrets:` / `ports:` key, a CEL binding.

That distinction is the only thing separating `kind: Console.WriteLine` from
`!ref Console.writeLine`, which are character-identical grammars, and the pair is
not hypothetical: it is the sanctioned singleton shape, where a library declares
`kind: Self.WriteLine`, exports the instance and withholds the kind. The docs
previously recommended PascalCase for instances on a CloudFormation logical-ID
analogy — the wrong precedent, since CFN logical IDs sit in a dedicated `!Ref`
slot with no expression language beside them, while a Telo name *is* a CEL
identifier and sits next to `variables.` in the same expression.

Three tiers, each with a different severity, because they fail in different ways:

- `INVALID_NAME` (error, every surface) — not `^[A-Za-z_][A-Za-z0-9_]*$`, or a
  CEL keyword.
- `INVALID_TYPE_NAME` (error) — a type-level name not starting uppercase.
- `NAME_CASE_CONVENTION` (warning) — a value-level name not starting lowercase.

The grammar tier is an error because the name is otherwise unreferenceable *or
silently mis-referenced*. Probed against the CEL engine the runtime actually
uses: `resources.in` and `resources.2fa` are ParseErrors, but
`resources.my-server.url` **evaluates**, as `resources.my - server.url`. Where a
bare name is in scope — which `x-telo-bindings-from` deliberately makes possible
— a hyphenated resource name therefore yields a wrong number with no diagnostic
anywhere. This replaces the old dot-only `INVALID_RESOURCE_NAME`, which was the
strictest special case of the same rule; checking one character while the rest
went unchecked is what left the hole. The reserved set is the whole keyword list
rather than the subset today's parser rejects in field position (`for` and
`package` currently parse) — which keywords tokenize there is a property of a
dependency, and a name that breaks on a parser upgrade was never safe.

The type-case tier is an error rather than a warning because half the reference
grammar already rejected the alternative: `EXTENDS_ALIAS_PATTERN` hard-rejects
`extends: foo.Bar`, while nothing rejected the `metadata.name: foo` that produced
it. A lowercase kind is a kind nothing can extend, so this only moves an existing
failure to where it is fixable. Value-level case stays a warning, Rust's
`non_snake_case` posture: a name is occasionally dictated from outside and Telo
has no way to silence a diagnostic locally.

Only the **first character** is checked. The type/value signal is all it carries,
and a full pattern would relitigate `httpApi` vs `httpAPI` and `OAuthClient` vs
`OauthClient` while rejecting an all-acronym type name like `SQL` or `AI`. There
is deliberately no quick fix: a `DiagnosticFix` is a whole-value replacement for
one node, and a rename is correct only when every reference moves with it.

Scoped to the entry's own modules at every tier, errors included — a published
dependency's naming is not the consumer's to fix — and a name synthesized by
inline extraction is skipped, since the author never wrote it. Step names come
from the call graph rather than a walk of their own, which already owns the
analyzer's only step-array recursion and carries each step's name, owner and
concrete path.

Two latent bugs surfaced in this repo: the `workflow` and `workflow-temporal`
modules were stragglers from the module-name PascalCase migration, and a hub step
named `record-failure` could never have been read as `steps.record-failure.result`.
