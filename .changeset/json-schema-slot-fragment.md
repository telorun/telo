---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/ide-support": minor
"@telorun/sdk": patch
---

A slot that holds author-written JSON Schema now says so, instead of being
declared `type: object` and nothing more. `telo://manifest#/$defs/JsonSchema7`
(plain data — an `inputType:`, a `status:` block, an API route's
`request.schema`) and `#/$defs/KindSchema` (a kind's own `schema:`, where the
`x-telo-*` vocabulary belongs) join the shared fragment set, and the built-in
`Telo.Definition` / `Telo.Abstract` / `Telo.JsonSchema` slots point at them.

The gain is that every surface reading a kind schema now knows what lives there:
completion offers the keyword set from the first key down and recurses into a
property's own schema, hover has titles and descriptions to show, and a `status:`
block is checked as a schema at `telo check` — anchored on the offending
keyword's line — rather than at dispatch. Which vocabulary a slot admits is the
fragment NAME, read off the derived `x-telo-fragment` stamp: the annotations are
offered inside a kind's schema and withheld inside a data schema, where they
would configure a slot that does not exist.

Wired at the built-in slots only — `Telo.Definition` / `Telo.Abstract`'s
`schema:` and `status:`, and `Telo.JsonSchema.schema`. A module's own
schema-valued slots still declare `type: object`: `inputType:` / `outputType:`
are `x-telo-ref` slots accepting four forms and need an `anyOf` branch rather
than a replacement, and a slot reached through `x-telo-schema-from` is
transplanted into the consumer's schema, where a document-local pointer resolves
against a root that has no such entry.

These two are the first RECURSIVE fragments, so they are not expanded in place
like the others — a shape containing itself has no expanded form. A reference is
rewritten to the document-local `#/$defs/telo:<Name>` pointer with one copy
hoisted to the root of the schema a validator compiles, which is the only
reference form the editor's resolver accepts and the one AJV resolves natively.
The key is reserved rather than plain, so a kind declaring its own
`$defs: { KindSchema: … }` cannot silently become what every slot pointing at the
fragment validates against; for the same reason `mergeTypeSchemas` now merges
`$defs` key-wise like `properties`, since an `extends` child declaring any would
otherwise erase the parent's hoisted entry. Siblings written beside the `$ref`
reach the human surfaces but not AJV, which draft-07 makes exclusive; a slot may
add a title, not narrow the shape.

Landing the check surfaced an abort that predates it: AJV's `addSchema`
meta-validates and THROWS, and the throw escaped the whole analyze pass, so one
author schema carrying `minimum: "3"` ended the run with AJV's unanchored text
and took every other diagnostic in the file with it. A schema AJV refuses is now
left unregistered — a `$ref` lookup entry that could not have resolved anyway —
and reported by the anchored checks that run afterwards.

The fragment body stays open (`additionalProperties: true`) and carries no
literal `x-telo-*` property names. Both are load-bearing rather than incidental:
closing it would reject the next annotation a module invents, and a `properties`
map holding a key spelled `x-telo-ref` reads to the annotation walkers as an
annotated node, inventing diagnostics about a slot nobody wrote. The vocabulary
completion offers therefore lives in the analyzer (`schema-keywords.ts`), on the
side of the boundary no manifest walk reaches.
