---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/cli": minor
---

A DECLARATION-derived contract (`x-telo-schema-projection-from`) is now resolved
at dispatch as well as at `telo check`. It was static-only, which is a contract
with a hole exactly where a value is COMPUTED rather than written: a misspelled
column written as a literal was rejected, and the identical key arriving from a
CEL expression reached the database — which for a repository kind means arbitrary
caller text in a SQL identifier position.

`ProjectionScope` becomes a resolver over the raw slot value rather than a list of
manifests, because the two hosts see different things there: the analyzer sees the
`{kind, name, alias?}` reference, while the kernel binds contracts after Phase-5
injection has replaced it with the live instance. That also makes reference
resolution alias-aware, so an unambiguous `!ref Alias.users` is no longer refused
as ambiguous merely because two libraries each export a `users`.

`x-telo-schema-projection` is read from `schema:` as well as from the kind
document and reported when it is found there — ignoring a misplaced annotation
moved the failure onto the consumer's slot and blamed the wrong author.

A ref slot inside a kind's `schema:` is typed as the published reading it yields,
so `self.<ref>.status.<field>` is checked instead of being read off the annotation
node. The runtime view is memoized against a publication counter rather than
rebuilt on every dispatch.

A resource rule that throws or exhausts its budget is anchored on the declaring
definition, and is a warning rather than an error when that definition belongs to
a published dependency — an error there blocked `telo check` on a line the
consumer could not change.

A projection that cannot resolve at dispatch now raises
`ERR_SCHEMA_PROJECTION_UNRESOLVED` instead of leaving the slot open — the
analyzer's report is entry-module-scoped, so a dependency's consumer slot was
unreported at both ends. Rule-declaration validation reads the same merged schema
the evaluation reads, so a rule declared on an abstract resolves its `in:` pointer
against the fields a child declares.

`telo publish` reads the npm controller candidates it may push from the PURL
parser it already uses, and the self-pin rewrite is anchored on the `controllers:`
scalars, so a PURL mentioned in a description is no longer a rewrite target. Its
package directory comes from the candidate's `local_path` rather than an assumed
layout, an unreachable npm registry is no longer read as "not published", and a
malformed `package.json` fails instead of silently skipping the pin stamp.
