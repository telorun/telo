# Resource rules — checking a declaration against itself

## Problem

A kind can already say a great deal about one field: its type, its shape, which
resource it may reference, what its value means. It can say nothing about how one
field relates to **another field of the same resource**. So every rule of that
form is enforced by a controller at boot, and `telo check` reports nothing.

The declarative SQL schema kinds are full of them. An index naming a column the
table does not declare; a foreign key whose two sides list different numbers of
columns; a `renamedFrom:` pointing at the column it is on, or at one the table
still declares; two table declarations for one physical table; a foreign key
whose target the schema does not list. Each is decidable by reading the YAML.
Each currently fails at start-up — several of them *after* an earlier phase has
already run DDL.

They are not SQL's problem. The same shape recurs wherever a kind holds a
collection whose entries refer to each other:

- `Run.Sequence` — a step's `inputs:` reading `steps.<name>.result` for a name no
  earlier step defines. (Today the call graph handles this specially.)
- `Http.Api` — a route naming a middleware the server does not mount.
- A workflow kind whose `retry:` names a step id.
- Any kind with a `default:` field that must be one of the values listed in a
  sibling `enum:`.

The analyzer cannot special-case any of them: it must never hardcode knowledge
about specific resource kinds (see CLAUDE.md, *Topology-driven constraint*). So
the mechanism has to be declared by the kind, as data, and resolved generically —
the way `x-telo-ref`, `x-telo-schema-projection` and the zone annotations are.

## What is out of scope

**Anything that needs the live database.** Type narrowing, `NOT NULL` over
existing rows, whether a unique constraint can be created — those depend on data,
the declaration is the only artifact, and they are correctly refused by the pass
at reconcile time. This is only about what the manifest can decide about itself.

**Cross-resource rules that are already expressible.** A reference to another
resource is `x-telo-ref`; a value that must satisfy another kind's contract is
`x-telo-value-schema-from`. Those exist and are not being replaced. The trivial
field-A-requires-field-B case is `dependentRequired`, which the zone-attribute
schema composition already uses — do not re-encode it here.

## The rule language is CEL

The predicate is a CEL expression over `self` — the variable a definition body is
already typed against — not a closed vocabulary of named rules over a bespoke
pointer language.

CEL is browser-safe in the analyzer: `analyzer/nodejs/package.json` already
depends on `@marcbachmann/cel-js` directly, and the CEL core
(`templating/nodejs/src/cel/`) is pure JS with `re2js` chosen precisely so it runs
in a browser. Evaluating rules at check time costs no new dependency.

A spike confirmed the whole surface these rules need, in the analyzer's own
environment (`buildCelEnvironment()` with no host handlers):

| Rule | Expression | Verified |
| --- | --- | --- |
| map-key membership | `"id" in self.columns` | keys, not values — no `*`-means-keys hack |
| iterate a map | `self.columns.all(c, …)` binds **keys** | ✓ |
| subset | `self.indexes.all(i, i.columns.all(c, c in self.columns))` | ✓ |
| correlated `sameLength` | `self.foreignKeys.all(fk, size(fk.columns) == size(fk.references.columns))` | correlates per element |
| discouraged value | `self.reclaim.afterDuration != "0ms"` | ✓ |
| uniqueness | `i.columns.all(a, i.columns.filter(b, b == a).size() == 1)` | works; O(n²) and ugly |

Correlating two paths under one wildcard binding — the part a pointer language
gets wrong, and the reason a hand-rolled path language would need designing — is
what a comprehension closure gives for free.

Cost is not a concern: a 300-column × 300-index nested comprehension evaluates in
**1.0 ms**. CEL has no loop construct beyond comprehensions over the manifest
itself, so evaluation is bounded by document size.

Because the analyzer can evaluate any expression, the vocabulary stays **open**
without becoming a name nothing reads — the opposite polarity from `use:` and the
zone attributes, which are closed because consumers branch on the name. Nothing
branches on a resource rule.

## A rule iterates what it anchors to

A bare boolean loses the anchor: the editor squiggle is a primary motivation, and
`all(...) == false` says nothing about *which* entry failed. So `in:` names the
collection to iterate, and the rule is a condition over one element:

```yaml
x-telo-resource-rules:
  - in: /indexes
    condition: !cel "this.columns.all(c, c in self.columns)"
    code: SQL_INDEX_UNKNOWN_COLUMN
    message: names a column this table does not declare
  - in: /columns
    condition: !cel "!(this.?renamedFrom.orValue(\"\") in self.columns)"
    code: SQL_RENAME_SOURCE_STILL_DECLARED
    message: renames from a column this table still declares
  - condition: !cel "self.reclaim.afterDuration != \"0ms\""   # no `in:` — about the resource
    code: SQL_RECLAIM_DISABLED
    severity: warning
    message: reclaim is disabled — a removed column is dropped on the next pass
```

`this` is the element under test — the value for a map entry, with its key also
bound — and `self` is the whole resource, so correlation reaches across
(`c in self.columns`) exactly as a plain comprehension would. The two coexist in
cel-js; the spike confirmed it. Omitting `in:` gives the whole-resource form,
which is what a discouraged-value warning wants; it reports at the resource.

**The vocabulary is borrowed from `Telo.JsonSchema.rules`**, which is the same
idea one layer down: a CEL `condition` that must hold, a machine-readable `code`,
and a `message`. Matching it is not cosmetic — two CEL rule vocabularies in one
system whose conditions have opposite polarity is a trap an author falls into
once per rule. So `condition` is TRUE when the rule HOLDS, and the subject binds
as `this`, exactly as it does there. Borrowing the polarity also simplifies most
expressions: the subset rule reads `this.columns.all(c, c in self.columns)` with
no negation at all.

`code:` names the rule, and every violation is reported under **one**
analyzer-owned diagnostic code, `RESOURCE_RULE_VIOLATED`, carrying the author's
code in `data.rule`. The envelope is what keeps the diagnostic-code namespace
closed: surfaces branch on `code` (`MODULE_REQUIRES_NEWER_RUNTIME` gates
suppression, `LIVE_VALUE_RETRIED` and `CEL_SYNTAX_ERROR` steer rendering), so a
published module free to emit any string could declare `SCHEMA_VIOLATION` and
shadow machinery that never expected a third party there — unvalidatable, since
the code is a string in someone else's artifact. `data.rule` keeps a violation
individually nameable, greppable and suppressible without entering the reserved
space, and it is the reversible choice: requiring a module-qualified prefix
(`SQL.INDEX_UNKNOWN_COLUMN`, the trust boundary the migration `inSchema` +
reserved-key pairing draws) can be layered on later as a check over `data.rule`,
with nothing that already consumes the envelope having to move. The cost is that
a consumer filtering by code sees one code for every rule and must read
`data.rule` to tell them apart.

`message` is required here (a diagnostic with no sentence is useless to the
author) where `Telo.JsonSchema` makes it optional behind a generated fallback.

**The two mechanisms stay separate**, despite the shared vocabulary. A
`Telo.JsonSchema` rule runs at dispatch, against a *value*, and its failure is a
`RuntimeError` carrying the code. A resource rule runs at `telo check`, against
the *manifest*, and its failure is a diagnostic. Different subject, different
time, different consumer — unifying them would mean one of the two runs where its
subject does not exist.

**`in:` is the anchor by construction**, and that is why the rule is not shaped as
an expression returning a set of offenders. CEL can return one — `filter` over a
map yields the offending keys — but then the pointer and the filtered collection
are two independent claims, and a rule anchored `/indexes` while filtering
`self.columns` would produce diagnostics at paths that do not exist, with nothing
to catch it. Iterating what the pointer names makes that unrepresentable. The cost
is that an offender set cannot be computed some other way, which none of the
motivating rules needs.

`message` stays author-supplied: only the kind's author knows what the
relationship MEANS. The analyzer supplies where and what.

The warning case falls out of the same annotation with `severity: warning` — no
second `x-telo-discouraged` family.

## Constraints the reader must enforce

Four edges the spike surfaced. The first three are enforced statically, at
`telo check` on the *kind*, so a bad rule is caught where it is written:

1. **Only `!hostBacked && deterministic` functions.** `CelFunctionDoc` already
   carries both flags. The 8 host-backed entries (`sha256`, `md5`, `sha1`,
   `sha512`, `hmac`, `base64Encode`, `base64Decode`, `json`) are registered in the
   analyzer as **stubs that throw** — the kernel injects the real ones at boot
   because they need Node `crypto` / `Buffer`, which the templating package must
   not import. The 8 non-deterministic entries (`nowIso`, `uuidv4`, …) evaluate
   fine and would make a check's verdict depend on when it ran. Both sets are
   rejected in a rule, naming the function and the reason.

2. **A rule that throws is a defect in the RULE.** An unguarded missing key throws
   (`self.nope.x` → `No such key: nope`) rather than yielding false. A throwing
   rule is reported against the kind's schema, never as a violation of the
   consumer's resource — a rule bug must not masquerade as a manifest error.

3. **A rule whose inputs are not statically resolvable is skipped — and the skip
   is REPORTED.** A manifest node may itself hold `!cel` leaves; take the
   `X_TELO_REF_DYNAMIC_SELECTOR` posture and skip rather than evaluate over
   placeholders. The skip is **per element**, not per rule — `in:` already gives
   that granularity, so one dynamic column does not switch a table's index check
   off. And it emits an informational diagnostic naming the rule and the dynamic
   leaf, for the reason `telo release` reports an unattributed bump rather than
   dropping it: a check whose coverage varies invisibly reads as passing when it
   did not run. Rules run **before** schema `default:` filling, so a defaulted
   field reads as absent.

4. **`has()` does not work on a dynamic index.** `has(self.columns[c].renamedFrom)`
   throws `has() invalid argument` — the macro needs a literal field selection.
   Under an iterated key, write `"renamedFrom" in self.columns[c]` or use optional
   chaining (`self.columns[c].?renamedFrom.orValue("")`; `enableOptionalTypes` is
   on). This is the shape every `renamedFrom`-style rule needs, so it belongs in
   the authoring guide.

Because `in:` names the collection, the reader resolves the kind's schema at that
pointer and registers `this` with cel-js, so an element's own fields are typed one
level down — which recovers part of the shallow-typing loss below.

**`check()` types `self` only shallowly.** cel-js's
`registerVariable({name, schema})` takes a flat `Record<field, celTypeString>`,
and `jsonSchemaToCelType` collapses `columns` to `map` and `indexes` to `list`. A
top-level typo is caught (`self.colums` → `valid: false`), a nested one is not
(`i.colums.all(…)` type-checks). Constraint 2 catches those at evaluation, but it
means rule authoring wants a test manifest, not just `telo check`. A rule that is
never exercised is therefore never proven, which is the second way coverage can
vary invisibly — so a rule whose `in:` collection is empty on every resource in
the workspace is worth reporting alongside the dynamic-leaf skip.

**Evaluation is budgeted.** The 1.0 ms measurement is one rule over one resource;
the pass is rules × resources, with comprehension nesting the rule's author
controls and the consumer does not. A dependency shipping a quadratic rule must
not be able to hang `telo check` or the editor's keystroke-time analysis. Bound
it per rule (a step or time ceiling), and report a rule that exceeds it as a
defect in the rule — the same polarity as constraint 2, and the `no silent caps`
posture: never a silent truncation of coverage.

**CEL rules are Node-analyzer-only until the Rust CEL engine lands.** The
migration, value-type and zone-attribute vocabularies are data specifically
because a predicate in one language is readable by one kernel only. CEL is the
sanctioned exception — a second Rust engine is the stated plan — but it does not
exist today. Accepted cost, stated rather than hidden.

## Where it runs

A per-resource pass over the entry's own modules, reporting under the single
`RESOURCE_RULE_VIOLATED` code with the rule's own name in `data.rule` and the
offending path in `data.path` so an editor can anchor it.

The scoping matches `X_TELO_REF_UNRESOLVED` for the **opposite** reason: there,
the broken declaration belongs to the dependency's author. Here the *rule* comes
from the dependency and the *violating data* is the consumer's own resource, so
the pass reports where the resource is declared — and a violation inside an
imported library's own resource stays silent because it is that library's to fix.

## Status

Landed. `analyzer/nodejs/src/resource-rule.ts` (the reader),
`validate-resource-rules.ts` (the strict half + the evaluation pass), wired into
`analyzer.ts` at the definition loop and the per-resource loop, registered in
`value-type-keyword.ts` / `schema-keywords.ts`. `Postgres.Table` declares five
rules plus the composite-primary-key one; `Sql.Schema` declares the
`afterDuration: 0ms` warning, inherited by every backend. Guide:
`docs/extend/resource-rules.md`.

Two things changed under implementation:

- **The dynamic-leaf skip is narrowed to the nodes the condition READS**, via the
  parsed access chains, not to the subject. Scanning the subject made the check
  useless in exactly the shape it matters most: a resource-wide rule takes the
  whole resource as its subject, so one unrelated `version: !cel "module.version"`
  — the conventional spelling — switched off every such rule. Caught by running
  the pass over the sqlite schema tests, where it fired on all of them.
- **A CEL node reaches the analyzer as `__tagged` with `__compiled` and `call`
  stripped** on the registered-definition path, so the reader tests both markers.
  Testing one made rules readable on some paths and invisible on others.

**No `requires:` floor is needed, verified by execution.** `KindSchemaSchema` is
`additionalProperties: true` and `Telo.Definition` carries
`capability: Telo.Template`, which switches `celRuleApplies` off so the `!cel`
values inside the annotation raise no `CEL_IN_NON_EVAL_FIELD` — and
`npx @telorun/cli@0.78.0 check modules/postgres/telo.yaml` reads the annotation
with no complaint. `modules/sql`'s existing floor is earned by the zone-attribute
object form, not by this: stripping it surfaces only `ZONE_ANNOTATION_INVALID`.
This is the `Assert.Events times:` case, and declaring a bound would be a claim
nothing checks.

## Not shipped

The `Run.Sequence` step-name rule was written as a genericity proof and left out.
The call graph stays the single source of truth for step names: it answers more
than one resource's own fields (nesting, `with:` scopes, reachability), and two
mechanisms reporting one defect differently is the drift this design avoids.

## Known limits

- **`check()` types `self` only shallowly** — cel-js's `registerVariable` takes a
  flat `Record<field, celTypeString>`, so `columns` is `map` and a nested typo
  (`this.colums`) survives declaration validation. It surfaces at evaluation as a
  throwing rule, and `RESOURCE_RULE_UNEXERCISED` is what says nothing exercised
  it. Rule authoring wants a test manifest, not just `telo check`.
- **The budget bounds the subject loop, not one expression.** cel-js exposes no
  step limit, so a single pathological expression over one huge element runs to
  completion. The budget catches the shape that actually occurs.
- **CEL rules are Node-analyzer-only until the Rust CEL engine lands.**

## Why not just leave them at boot

They fail with good messages today, and the app stops. The argument for moving
them earlier is not cosmetic:

- **Some of them fail after DDL has run.** `beforeMigrations:` executes before
  reconciliation, so a manifest that is wrong in a way only reconciliation
  notices has already changed the database by the time it is told.
- **A boot failure needs a database.** `telo check` runs in CI, in the editor and
  on a laptop with no PostgreSQL. Every rule here is decidable there.
- **The editor cannot show them.** Diagnostics are what the GUI renders; a
  controller's exception is invisible until something runs.
