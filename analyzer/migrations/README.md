# Manifest migration entries

One JSON file per migration — a legacy manifest spelling and the edit that
rewrites it to the current one. The set is read as one lexically ordered list,
so adding a migration is one file and retiring one is deleting it. Nothing lists
the entries by hand: `scripts/copy-migration-entries.mjs` emits the barrel from
the same directory listing that copies them into the analyzer package, so a file
that exists here always runs.

The files sit here, beside the language implementations rather than inside any
one of them, because **every kernel must apply the identical rewrite**. A
rewrite added to one side would mean one artifact means two things on two
kernels, invisibly — a migration that succeeds is silent. `analyzer/nodejs`
imports these files directly. `analyzer/rust` does not read them yet: until it
does, the Rust kernel applies no migration at all, so a legacy spelling fails
there rather than being rewritten differently. When it lands it will embed them
with `include_str!`; a Go half would use `//go:embed`.

JSON rather than YAML for one reason: it is the only format all three can embed
with no generation step. Rust and Go can embed any text file; TypeScript cannot,
and its only native embed is `resolveJsonModule`. Author notes go in
`$comment`, which the reader ignores.

**An entry contains no code.** Both halves — what a rule matches and what it
patches — are data. A predicate expressed in one language would be readable by
one kernel only, which is the divergence this layout exists to prevent.

## Shape

```json
{
  "id": "ref-slot-scalar-type",
  "code": "X_TELO_REF_SCALAR_TYPE",
  "severity": "warning",
  "reason": "Why this spelling changed — a sentence or two.",
  "rules": [
    {
      "match": {
        "key": "type",
        "inKind": ["Telo.Definition", "Telo.Abstract"],
        "under": ["schema", "status", "inputType", "outputType"],
        "valueOneOf": ["string", "number", "integer", "boolean"],
        "withSibling": "x-telo-ref",
        "notUnder": ["const", "default", "enum", "examples"]
      },
      "patch": [{ "op": "remove-entry" }]
    }
  ]
}
```

### `match` — what the rule selects

Read by `analyzer/nodejs/src/migrations/match.ts`. **Containment is positive and
required**: `inKind` names the document kinds a rule may touch, `under` the
region within them it may reach. Nothing outside is reachable. Walking
everything and subtracting cannot be made sound — the set to subtract is
unbounded, since any kind whose config carries a user JSON blob can hold
something shaped like the node a rule looks for, and forgetting one corrupts a
manifest with no diagnostic.

**`under` is anchored at the document root**: it names TOP-LEVEL keys, and the
match must be at or below one of them. Anchoring is what makes the containment
claim true rather than decorative — a `Telo.Definition`'s `resources:` template
body carries other kinds' configuration, so "some segment of the path is
`schema`" would reach the very user JSON blob the positive form exists to keep
out, and delete from it silently.

| key | required | meaning |
| --- | --- | --- |
| `key` | yes | the mapping key this rule rewrites |
| `inKind` | yes | document `kind:` values this rule may match in |
| `under` | yes | top-level document keys; the match must be at or below one of them |
| `value` / `valueOneOf` | no | the value must equal this / be one of these |
| `withSibling` | no | a key that must be present in the same mapping |
| `notUnder` | no | narrows within `under` — the data-bearing JSON Schema keywords |

Matching against the *known* legacy values (`valueOneOf`) rather than any value
is what leaves an unrecognized one alone for the ordinary validator to report,
instead of silently rewriting it.

### `patch` — what the rule does

The closed operation vocabulary — `rename-key`, `set-value`, `set-tag`,
`insert-item`, `remove-entry` — read by
`analyzer/nodejs/src/migrations/entry-data.ts`. Every operation has a known YAML
edit form, which is what lets `telo migrate` apply one to a file and what lets
the driver derive whether a quick fix exists, straight off the verb.

A written `value` must be a **scalar** (string, number, boolean, `null`). The
file applier renders one by re-quoting it in the author's own style at the
node's own span, which has no meaning for a mapping or a sequence — so a
structured value is refused when the entry is READ, rather than accepted and
then reported forever as "fix it by hand" the first time someone runs
`telo migrate`. Writing a structured value is a vocabulary extension (a block
renderer), not something an entry can reach for today.

`reason` is the only prose an entry writes. The driver generates what changed
and how to apply it identically for every entry.

The vocabulary is closed in both halves, and an unknown token is refused rather
than ignored — that is the trust boundary once module-shipped entries are
aggregated beside these.

## `inKind` naming a module's kind — a debt, not a pattern

`schema-prepare-bucket` names `Postgres.Schema` and `SQLite.Schema`. A **core**
entry may name any `inKind` and this one has to, because the module surface does
not exist yet — but it is the one thing in the analyzer that knows a standard
library kind by name, which the topology-driven constraint otherwise forbids
outright.

It stays contained only because `inKind` is a *filter*: an entry naming a kind
that is not present matches nothing, so the cost of the debt is a dead rule
rather than wrong behaviour. Two rules follow from that while it stands:

- **Do not add another.** A rename that a module owns waits for the module
  surface, or ships as a widened kind schema that accepts both spellings.
- **When the module surface lands, this entry MOVES** to `modules/postgres` and
  `modules/sqlite` and this section goes with it. It is the forcing case, so
  nothing else should be allowed to accumulate behind it.

The full guide is `docs/extend/manifest-migrations.md`.
