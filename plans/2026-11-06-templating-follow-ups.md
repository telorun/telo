---
status: in-progress
priority: high
depends-on: []
packages: [analyzer/nodejs, kernel/nodejs, templating/nodejs, tests, docs]
refinement: ready
tracking: feat/templating-follow-ups
---

# Templating follow-ups: finish the analysis over configurations, close the template-body gaps

## Problem

A *configuration* is one assignment of the values a manifest's choices read
(`variables.flag1 = true`, a need present or absent). `telo check` gives each finding a
*presence condition* — the configurations it holds in — and is meant to judge every check
once over all of them, at a cost that grows with the number of choices and never with the
number of configurations.

Most of the analysis works that way: CEL, schema and own checks, resource and referrer
rules, references, the call graph and the passes over it, the need table, texts, the
document-level stages, and every read of a named shape (a `Telo.JsonSchema` / `Telo.Type`
declaration, which may itself be declared under a choice or hold one). What remains:

- **A chain of named shapes multiplies.** A check that reaches a named shape reads it and
  every shape it references onward, whole, so its cost is the product of the classes along
  the chain: on a resource writing values through k varying shapes the counters below
  double per shape, and the check runs out of memory at k = 8.
- **A few checks still run once per configuration**, and the per-configuration loop and
  the unreachable-branch loop still exist beside the analysis over all configurations.
- **Template bodies are checked less strictly than ordinary declarations**: some mistakes
  inside a body, or in what a consumer passes to one, are not reported, and some values in
  a body are typed in a way that does not match what the kernel hands them at run time.

The loop's working notes (rulings, builder reports, the corpus dump rig) are in
`~/.cache/telo-e2c/`; nothing below depends on them.

## Constraints

None.

## Surface

**Added** — none.

**Changed**

- `IMPORT_ALIAS_SHADOWS_CONTEXT` — no longer reported for a `Telo.Import` declared as a
  scope member; where several kinds put one alias in scope, the message names the kind of
  the first such declaration in source order.
- `CEL_TYPE_ERROR` / `CEL_UNKNOWN_FIELD` — also reported for a module call whose
  `params[].schema` / `returns.schema` nests a `$ref` to a named shape, and for
  `self.<field>` in a template body step's `value:`.
- `TEMPLATE_TARGET_MISMATCH` — also reported where the dispatched entry kind's
  `inputType` is derived from the entry (`x-telo-value-schema-from`,
  `x-telo-schema-projection-from`).
- `REFERENCE_KIND_MISMATCH` — also reported at a reference slot inside a template body's
  `resources:` entry.
- `RESOURCE_RULE_INVALID` — no longer reported on a consumer's forward view for a field the
  body or a schema default supplies.

**Removed** — none.

## The oracle and the measurements

- **The differential** — per configuration, the conditioned findings equal a plain
  analysis of that configuration's expansion; the **definition differential** does the
  same per template-definition variant. Every new fixture is recorded first on the code it
  replaces.
- **The parity oracles** — the relation census against each configuration's enumeration
  (`relation-sites`), the call graph over every configuration against each configuration's
  own (`conditioned-call-graph`). Both are deleted with the loops in part 3, after which the
  differential alone judges.
- **The corpus dump** — every manifest in the tree analysed, compared byte for byte before
  and after a change; a change lists every differing finding.
- **The cost fixtures** — **V** (N steps, step k a `value: !if variables.flagK` reading the
  one before), **W** (V's steps in one `try:`), **S** (N jobs, each declared only when its
  flag holds, started from an `!if` item of `targets:`, with a call cycle through two
  choices), **T** / **Tn** (V's steps written by a consumer of a templated kind, Tn beneath
  a sequence holder).
- **The chain fixture C(k)** — k named shapes `S1 … Sk`, each `schema: !if variables.flagI`
  whose `then` declares a reference slot `x` (`x-telo-ref: { kind: Telo.Invocable, use:
  call }`) and whose `else` declares `x` as a plain object, each holding `next: { $ref:
  telo://Self/S<i+1> }`; one kind `Route` whose `s` `$ref`s `S1`; one resource writing an
  inline `Telo.Value` at every `x` down the chain. Today, at k = 1/2/3/4: 2/4/8/16
  normalizations of the resource, 7/15/31/63 schema-door evaluations, 6/15/35/79
  relation-door evaluations; k = 8 runs out of memory.

Every part keeps the differential green and the corpus dump byte-identical apart from what
it lists, each listed change with a fragment line.

## 1. Named shapes are read one hop at a time

### 1a. The chain gate

- **Before:** nothing in the tree measures C(k); the numbers above come from a probe.
- **After:** the first change of this part adds an in-tree counter test over C(k) at
  k = 1/4/8/16 asserting the After numbers of 1b and 1c. It is red until 1c lands and stays
  as the gate.
- **Verify:** the test fails on the tree before 1b, printing today's numbers.

### 1b. A slot a varying shape declares is written into the normalized union once

- **Before:** a reference slot that only some classes of a varying named shape declare is a
  cut point of the declaration holding a value there. Normalization decides every cut point
  at the key's witness, so a key part carries the decided combination and one declaration
  is normalized once per combination (2^k on C(k)).
- **After:** a cut point is written into the normalized union as a two-option node, as a
  written choice is: under the site's condition (a class declaring the slot ∧ that class
  reached, OR over the classes) the inline value is extracted and the slot holds a
  reference to it; under its negation the value stays as written. A declaration is
  normalized once per content, a part never carries decided cut points, and normalization
  never runs at a decided-reach witness. Decided reach stays only where one configuration is
  consumed: the differential, and the configuration runs until part 3.
- **Verify:** C(k): one normalization of the resource at k = 1/4/8/16. Seeded fault — a part
  carrying the decided cut-point vector — makes the count grow with k. Differential green.

### 1c. A check reads only the named shapes it names directly

- **Before:** own-check keys, relation keys (the shapes in force at the anchor and at each
  read place), the contract shapes of a resolved target or scope member, a CEL site's name,
  callee and annotation reads, and module-call signatures each read every named shape they
  reach, whole and transitively, so a key's classes are the product of the classes along
  the reach path. A value checked against a slot schema that lies beneath a named shape
  folds the reach closure into one class.
- **After:** a check reads only the named shapes it names directly — the contract shapes of
  its resolved target or scope member, the shapes in force at its anchor, those at its read
  places, those its annotations name — each through the named-shape reader as that one
  shape's own class. A named reference inside such a shape is answered as a reach edge (the
  shape's id), never by the inner shape's content. What a check needs beneath a reference is
  a sub-verdict, memoised by (shape, class, position — the remaining member path, or the CEL
  type fitted there), or for a comparison by (position pair, class pair), joined to the
  check by the one condition-labelled reach graph and its fixpoint, so its finding holds
  under class ∧ reach. A CEL chain through k nested shapes is judged hop by hop: a sum, not
  a product. A slot schema beneath a named shape is the reader's census answer per class. A
  missing shape is skipped, since `CONTRACT_TYPE_NOT_FOUND` / `SCHEMA_TYPE_REF_UNRESOLVED`
  report it. A finding's text is the plain driver's; where it differs per position it is
  split, naming the first failing position in written order under the negation of the
  earlier ones. The fold of the reach closure is deleted with no fallback, and so is the
  per-shape split that today keeps a `Telo.Function` whose `returns.schema` names a varying
  shape from crashing — replaced by this read, not dropped.
- **Verify:**
  - C(k) at k = 1/4/8/16: schema-door and relation-door evaluations each t(2k)/t(k) ≤ 2.5;
    sub-verdicts ≤ the total number of classes (counter); k = 16 completes; a misfit at
    depth j is one finding labelled class_j ∧ reach_j.
  - `function-signature-shape-choice.yaml` does not crash; a body that does not fit
    `returns: !ref Money` is one finding labelled with the misfitting class; the slot-fit
    site's key count is constant over k.
  - Counter: content of a varying shape read anywhere but through the reader = 0, across the
    corpus and the generated corpus.
  - Seeded faults: restoring the fold makes the key count grow with k; a reach condition
    forced TRUE turns the differential red; a judge reading a varying shape's content by id
    makes the withheld-read counter non-zero.
  - Plain-driver text byte-identical.

### 1d. A slot inside an extracted declaration

- **Before:** a cut point inside a declaration that inline normalization extracted gets no
  census run, so its sites are found only on the side the first run takes.
- **After:** the census reads every extracted declaration as a declaration of the union under
  its parent's condition ∧ the site condition — the same one-root-run-per-side census and
  content-keyed cache, recursively; no separate nested path.
- **Verify:** fixture with a cut point inside an extracted declaration → one finding labelled
  with the inner class ∧ the outer site condition; differential green; a seeded fault
  skipping the census for extracted declarations turns the fixture red.

### 1e. A declaration's own checks at a slot a varying shape declares

- **Before:** own-check keys read the shapes in force at the declaration's root whole
  (correct, but a product), and where a nested value stands (extracted, or a member of its
  holder) is answered from one witness.
- **After:** each nested place carries its kind of place (extracted | member) and the
  condition it holds under — TRUE where it is extracted in every configuration, FALSE where
  it is content in every one, undecided as today — its content answer holding under the
  negation. The slot's condition comes from the one conditioned reach read (class ∧ reach,
  OR over classes), never a witness; a witness answers only slot-ness that does not vary.
  Where the condition is not constant, an own-check site opens at the slot with two options
  split by separability: under the condition, the reference check; under its negation, the
  schema checks over the value as content; the extracted declaration is a declaration of its
  own under parent ∧ condition. Nothing beneath the slot is cut on the parent's side, and
  nothing is multiplied. The analyzer guide gains: "an own-check site opens at a slot a
  varying named shape declares."
- **Verify:** `shape-inline-slot-schema-choice.yaml` and `shape-inline-slot-kind-choice.yaml`
  stay one labelled finding each; a new fixture with two independently varying slots, each
  misfitting in one class → two findings with their own conditions, own-key evaluations 2
  per site, not 4; a seeded fault answering by witness turns it red; differentials green.

### 1f. A nested `$ref` in a function signature is followed

- **Before:** in both drivers, a `$ref: telo://Self/<Type>` nested inside a `Telo.Function`'s
  `returns.schema` or `params[].schema` object is not followed when a call is typed:
  `Self.price(1).m.amount`, with `m` a `$ref` to a string-typed `Money`, passes.
- **After:** the nested reference is made canonical where the signature's shape id is
  produced, `params` as well as `returns` — no second resolver. A union reads the nested
  shapes through the key's lookup, linearly (1c). If the kernel does not follow it either,
  its half gives the existing sentence and gains a `tests/check-run-agreement.yaml` row.
- **Verify:** `Self.price(1).m.amount` with `m` nesting a `$ref` to a string `Money` is
  refused in both drivers with the code the root shape gives; an object `Money` with
  `amount` gives none; a nested `params` mismatch is refused; `Money` varying under `flag1` is
  labelled, differential green; a chain of k nested signature shapes joins 1g's table with
  t(2k)/t(k) ≤ 2.5. New corpus findings listed; a `Fixed` fragment.

### 1g. Every stage over all configurations stays linear

- **Before:** no stage-by-stage profile exists, and C(8) runs out of memory.
- **After:** a table of time and counters per stage over all configurations — key parts,
  the census, the CEL-site solve, kind annotations, kind contracts, and the rest — at
  k = 1/4/8/16 on C(k) and 1f's chain, each stage within t(2k)/t(k) ≤ 2.5. The share of the
  configuration and dead-branch runs is part 3's.
- **Verify:** the table recorded in the change's report; any stage over the bound fixed in
  this part.

## 2. The last checks judged per configuration

Each check below moves out of the configuration runs. For each: counted once per key (or
once per analysis) on S at N = 1/4/8 and never inside a configuration or dead-branch run; a
fixture whose finding holds only under `!if variables.flag1` reports it labelled exactly as
the `within` analysis of each configuration does; a seeded fault forcing its condition TRUE
turns the differential red.

### 2a. Relation readers

- **Before:** these still run in each configuration: a rule condition's module calls on a
  kind's `x-telo-resource-rules` / `x-telo-referrer-rules` (`FUNCTION_*`);
  `CONTRACT_INPUTS_AT_RUN_SITE` and `CONTRACT_SLOT_INPUTS_UNSATISFIABLE`;
  `CONTEXT_FILL_CYCLE`; and a whole `!ref` supplied to a child application's need
  (`REFERENCE_KIND_MISMATCH`, `NEED_FORWARD_INCOMPATIBLE` at an `x-telo-application-source`
  resource's `needs:`).
- **After:** each is a relation reader with declared reads, judged once per relation key:
  - *rule calls* — anchored at each rule's `condition` in the kind document, reading by name
    the module functions the condition calls and onward the callables their bodies call;
    reported with the rule-absence family;
  - *reference-slot wiring* — at each reference slot, reading the resolved target's
    contract places;
  - *context fill cycles* — at the list whose entries fill a binding's members, reading the
    entries;
  - *application need references* — at each `needs:` entry holding a whole `!ref`, reading
    the declaration it names.
- **Verify:** fixtures: the callee of a rule condition declared only under a choice; a run
  site whose target's contract varies; a fill cycle closed only in one branch; a child
  application's need supplied by a `!ref` whose target varies — each labelled.

### 2b. Passes over a module's whole population

- **Before:** `IMPORT_ALIAS_SHADOWS_CONTEXT`, a referrer rule whose condition fails to
  compile, and `EXPORT_KIND_UNKNOWN` / `EXPORT_RESOURCE_UNKNOWN` run per configuration. The
  first counts a `Telo.Import` declared as a scope member as one of the module's imports, so
  a scoped import aliased like a context variable is reported though no module call can
  reach it.
- **After:**
  - **Module-call names** — one pass over every present declaration of each of the entry's
    modules (top level, extracted, scope members, forward views), each with its condition.
    A module's imports are read by one reader — the module document's `imports:` plus its
    top-level `Telo.Import` documents, never scope members — shared with the module-call
    names and the module's alias table. The names a kind's CEL contexts declare are
    conditions: the kind's own bindings TRUE, a binding inside a varying named shape under
    its class ∧ reach, each class's names computed once. A finding is one per (module,
    alias), held under the OR of the presences of the declarations whose kind puts the alias
    in scope; its wording names the kind of the first present such declaration in source
    order (declaration i under Pi ∧ ¬(P1 ∨ … ∨ Pi−1)), the plain driver choosing the same.
  - **A referrer rule's condition that does not compile** — judged once, held where a
    resource of the kind is declared, its example the first present such declaration in
    source order, once per (kind, code).
  - **Exports** — one pass over the conditioned name index: an entry naming nothing holds
    where no declaration of that name is present.
- **Verify:**
  - Kinds A and B both put `Billing` in scope, their declarations under the two branches of
    `!if variables.flag1` → two wordings, each labelled as `within` gives it; a fault
    forcing Pi to TRUE turns the differential red; a fault taking list order turns red a
    fixture whose list order differs from its written order.
  - A scoped `Telo.Import` aliased like a context variable → no
    `IMPORT_ALIAS_SHADOWS_CONTEXT`; a top-level one still gets it.
  - A context binding inside a named shape varying under `flag1` → the finding labelled; the
    kind's own bindings unlabelled; each class's names computed once at N = 1/4/8; a fault
    taking reach as TRUE turns it red; no context walk counted in any run.
  - An export naming a resource declared only under `flag1` → `EXPORT_RESOURCE_UNKNOWN`
    labelled `(when variables.flag1 is false)`.

### 2c. Callable data

- **Before:** `CALLABLE_REFERENCE_NOT_DATA` runs per configuration.
- **After:** one pass over the conditioned call graph, once over its connectives. Each node's
  own verdict (an expression whose eval mode is neither `compile` nor `accessor`, a present
  `x-telo-scope` field, a need or a fulfilment) is read once per chain of its options. The
  walk follows the graph's edges at reference sites, scope first, through the conditioned
  name index; within each node, sites in order against the condition still uncovered; one
  memo per node, except a cycle's results. A template body is judged unit by unit; a
  library's side is judged once per library under TRUE and continues at the references an
  import supplies into the union's node verdicts.
- **Verify:** a native function's data slot naming a resource that holds a runtime-eval
  expression only under `!if variables.flag1` → labelled `(when variables.flag1 is true)`; a
  two-hop chain whose first finding differs per branch → two wordings; a cycle under a
  choice; a library input supplied with a varying declaration → import-anchored, labelled.
  Faults: an edge condition forced TRUE turns the differential red; ignoring the uncovered
  condition turns the expectations red.

### 2d. Passes over the call graph

- **Before:** `CO_REFERRER_SCOPED`, `X_TELO_REF_DYNAMIC_SELECTOR`, and the never-run half of
  `OBSERVED_STATE_NEVER_RUN` run per configuration.
- **After:** each reads the conditioned call graph:
  - *scoped co-referrers* — the graph carries each node's scope, scope owner and site, and
    the lifetime of a scoped import's instance (from its members' presence); a finding also
    names the scoped import kinds it involves;
  - *dynamic selectors* — every edge whose use a dynamic selector decides is reported where
    the edge holds; the graph is the one reader of use selectors;
  - *never run* — a CEL key emits a candidate naming its resolved target; a cover removes the
    candidate wherever the target is reached by a control-transferring route from a root
    (a fixpoint over the graph's connectives; an injected declaration counts as reached).
- **Verify:** a scope member co-referrer under `!if variables.flag1` labelled; a scoped
  import's instance whose target outlives it reported only where the import is present; a
  dynamic selector in one branch labelled; a target started only where `flag1` holds → the
  never-run finding labelled `(when variables.flag1 is false)`. Faults: an edge condition
  forced TRUE turns the differential red; the reach cover forced FALSE turns the never-run
  fixture red.

### 2e. What a consumer's expansion of a template body refuses

- **Before:** the refusals of a consumer's expansion of a templated kind's body
  (`REPEAT_COMPUTED`, an open or refused expansion, a duplicate key) and
  `TEMPLATE_TARGET_UNKNOWN` / `TEMPLATE_TARGETS_CAPABILITY` are reported from each
  configuration's run.
- **After:** the expansion lifted over all configurations carries each report's holding. The
  targets findings hold where no refusal of the same expansion holds. Each finding is
  reported once, under the consumer's condition ∧ its holding. For an imported library, the
  same expander runs over each library instance's consumers, lifted over the entry's
  configurations; a library value is read through the import's binding (a literal fact, a
  bare chain naming the importer's dimension, else open), reported at the import; an open
  binding is reported once, as `BRANCH_UNDECIDABLE`. The kernel's expander stays unlifted.
- **Verify:** a computed `!for-each` source in a consumer only under `!if variables.flag1` →
  `REPEAT_COMPUTED` labelled; a targets problem in a branch with no refusal → labelled; a
  library consumer value chained through the binding to the entry's dimension →
  import-anchored and labelled; an open binding → only `BRANCH_UNDECIDABLE`. Fault: holding
  forced TRUE turns the differential red. The consumer expander runs in no configuration
  run (counter).
- The last change of this part also shows every configuration run and dead-branch run
  emitting zero findings across the corpus and the generated corpus (counter) — part 3's
  precondition.

## 3. Delete the per-configuration loop

- **Before:** beside the analysis over all configurations, `telo check` still enumerates
  configurations and runs each, and runs each branch no configuration takes, to normalize
  and to feed the parity oracles.
- **After:** no production code iterates configurations: the configuration run loop, the
  dead-branch loop and the configuration enumeration in choice reading are deleted; the
  differential's configuration list moves into the tests. The plain driver stays only for
  manifests with no choices and no template constructs, and as the differential's oracle.
  The unused, exported `requiredWhenOf` goes with the enumeration. Nothing reads a varying
  named shape's content except through the named-shape reader. This part's fragment says
  checks are no longer repeated per configuration, nor per way of deciding a template
  definition's own choices, so a manifest or a template body with many independent choices
  costs about what one with a few does. The
  cost-model paragraph of `docs/guides/choosing-by-configuration.md` states the cost model,
  and the analyzer guide's *Choices and configurations* text is rewritten to match.
- **Verify:**
  - The run counter reports 0 configuration runs and 0 dead-branch runs; no production module
    refers to the enumeration (an import-boundary test).
  - A grep test and a counter: nothing reads a registered or announced copy of a varying
    named shape, by id or otherwise, outside the named-shape reader.
  - V and S: t(8)/t(4) ≤ 2.5 and t(16)/t(8) ≤ 2.5. C(k): the whole `telo check`
    t(8)/t(4) ≤ 2.5 and t(16)/t(8) ≤ 2.5.
  - `telo check` at N = 16 ≤ 2 × N = 1; a cold `telo run` at N = 8 ≤ 2 × N = 1.
  - The signature bench (`reached` and `isolated`, median of 10): no choice ≤ 1.05 × the tree
    before this part; one configuration ≤ 1.5 × no choice at 300 and at 3,000 resources, the
    two ratios within 10% of each other; at 1/2/4/8/16 configurations each doubling's
    increment ≤ 1.25 × the first doubling's, or ≤ 2% of the one-configuration time,
    whichever is larger. A seeded per-configuration cost (one plain pass per configuration
    put back) fails the slope row.
  - N definitions each holding `!if variables.flagK` in their body: t(16)/t(8) ≤ 2.5.
  - `within` at the first full configuration ≤ the whole analysis at N = 1/4/8/16.
  - Expectations byte-identical; differential green.

## 4. Template-body gaps

### 4a. A template's `inputs:` against an entry contract derived from the entry

- **Before:** `TEMPLATE_TARGET_MISMATCH` is never reported when the dispatched entry kind's
  `inputType` is `x-telo-value-schema-from` / `x-telo-schema-projection-from` over the entry
  (the `ui` kinds' `inputType: { x-telo-value-schema-from: inputModel }`). `model: !ref
  Count`, a crossing `/model/shape` into a module declaration, and `model: !ref <sibling
  entry>` all pass with a refused value.
- **After:** the call site's contract resolution resolves the entry's references through the
  template body's own lookup (siblings, then the defining module, `<Alias>.<name>` through
  its imports). The static slot check and the kernel's creation-time decode of `inputs:`
  change together.
- **Verify:** a generated fixture with the three forms, each `inputs:` writing a refused
  value, reports `TEMPLATE_TARGET_MISMATCH` at `inputs.<field>`; none before. A
  `tests/check-run-agreement.yaml` row: refused at check, `runFails:` as the kernel prints
  it. Run the kernel side first to confirm what it refuses today.

### 4b. A body entry's reference to a resource of the wrong kind

- **Before:** a `Telo.Definition` whose `resources:` entry holds `src: !ref thing`, `thing` a
  `Self.User`, where the slot's `x-telo-ref` wants `Self.Thing`, passes `telo check`.
- **After:** `REFERENCE_KIND_MISMATCH` at the entry's slot, as for a top-level declaration.
- **Verify:** the fixture reports it; a `tests/check-run-agreement.yaml` row records what the
  kernel does at creation.

### 4c. Resource rules over a forward view see the whole entry

- **Before:** a templated graph-store wrapper declaring a default bookkeeping table gives four
  `RESOURCE_RULE_INVALID` warnings ("no such key 'nodes'") instead of
  `GRAPH_TABLE_NOT_IN_SCHEMA`: the rule sees only the forwarded fields.
- **After:** a rule judged on a forward view reads the entry as the consumer instantiates it —
  forwarded values, body literals, and the schema defaults the consumer left out.
- **Verify:** the wrapper fixture reports `GRAPH_TABLE_NOT_IN_SCHEMA` and no
  `RESOURCE_RULE_INVALID`.

### 4d. `self` in a body step's `value:` is typed, and matches run time

- **Before:** `self.<field>` is `dyn` in a template body step's `value:`, so `self.n * 10`
  with a `number` field is never a `CEL_TYPE_ERROR`. It was also recorded that `self.<integer
  field>` arrived as a double while check typed it `int`; it is unconfirmed whether the
  declared-integers change closed that.
- **After:** `self.<field>` in a body step's `value:` is typed from the definition's schema,
  and the value the kernel binds has the declared representation.
- **Verify:** `self.n * 10` with `type: number` is `CEL_TYPE_ERROR` at check; with `type:
  integer` it checks and runs (an `Assert.Equals` on the result). The integer case runs on
  the tree first; if it already passes, it becomes a pinned row with no code change.

### 4e. The end-to-end import test of the kernel's configuration view

- **Before:** a library kind whose `schema:` `$ref`s its own unexported named shape checks
  and boots (pinned by a `tests/check-run-agreement.yaml` row), but the kernel's
  configuration view over such an import has no end-to-end test.
- **After:** an import test of the kernel's configuration view through that library.
- **Verify:** the test is red without the view reading the import's configuration.

## Known defects found along the way

Found while building the rest; none is part of the work above, each reproduces on the
released tree unless stated.

- A named shape whose whole `schema:` is an `!if` holding a `$ref` to the `Text` fragment
  crashes at registration.
- `UI_FILTER_DUPLICATE`'s rule reads `property` without a presence guard.
- 22 dependency-verdict fixtures fail the rust-parity sweep at the base.
- A `Ui.View` read reports `CEL_UNKNOWN_FIELD` beside `CEL_UNKNOWN_IDENTIFIER` for one
  mistake.
- `templating/nodejs/tests/module-call.test.ts` fails to type-check at line 199.
- On this branch only: a consumer of a templated kind that forwards a field under an `!if`
  with no `else` (`open: !if { if: !cel "variables.flag1", then: true }`) into a body entry
  holding `open: !cel "self.open"` crashes the analysis with `internal: the key of own-check
  site … does not hold where it was read.` (with `else: false` it checks).

## Order

1a → 1b → 1c → 1d → 1e → 1f → 1g → 2a → 2b → 2c → 2d → 2e → 3. Part 4 is independent of
the rest.

## Release

- A fragment per user-visible change, through `telo release add`, on the units it changes
  (`analyzer`, plus `kernel` / `templating` where their half changes); each listed Surface
  change and each newly reported finding named in it. No new manifest syntax, so no
  `requires:` floor.
- `docs/reference/diagnostics.md` rows for new or reworded refusals.
- `analyzer/nodejs/CLAUDE.md` and `kernel/nodejs/CLAUDE.md` updated where the mechanism they
  describe changes, the authoring agent's primer where a refusal it teaches changes.
