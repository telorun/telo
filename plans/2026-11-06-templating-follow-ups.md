---
status: approved
priority: high
depends-on: []
packages: [analyzer/nodejs, kernel/nodejs, templating/nodejs, tests, docs]
---

# Templating follow-ups: finish the analysis over configurations, close the template-body gaps

## Problem

The template-expansion work shipped `!if` / `!switch` / `!for-each`, choosing by
configuration and template expansion at `init()`. It was stopped before it finished,
and what was left went to the loop backlog. Three kinds of debt remain:

- **The analysis over configurations is half converted.** A *configuration* is one
  assignment of the values the choices in a manifest read (`variables.flag1 = true`, a
  need present or absent). The intended design gives each finding a *presence
  condition* — the configurations in which it holds — computed in one pass. Today
  resource rules, CEL, schema and four whole-set passes work that way; every other check
  still runs once per configuration. The answers are correct, but cost grows with the
  configuration count, and the cost targets below are not met.
- **Two bugs the template-expansion work introduced** in how choices are checked.
- **Template bodies are checked less strictly than ordinary declarations**: some
  mistakes inside a body, or in what a consumer passes to one, are not reported, and
  some values in a body are typed in a way that does not match what the kernel hands
  them at run time.

Every design below was settled during the loop. The builders' notes (seams, traps,
timings) are in `.claude/loops/2026-10-27-template-expansion/03c-presence-conditions/`
(`builder.md`, `decider.md`) for whoever builds it.

## The oracle and the measurements

Two existing harnesses judge every part of this plan:

- **The differential test** — per configuration, the conditioned findings equal a plain
  analysis of that configuration's expansion. Every new fixture is recorded first on the
  per-configuration code it replaces, so the recording pins today's answers.
- **The configuration cost benches** over generated fixtures: **V** (a sequence of N
  steps, step k a `value: !if variables.flagK`, each reading the one before it),
  **W** (V's steps inside one `try:`), **S** (N jobs, each declared only when its flag
  holds, started from an `!if` item of `targets:`, with a call cycle through two
  choices), **T** / **Tn** (V's steps written by a consumer of a templated kind, Tn
  beneath a sequence holder).

## 1. Choice bugs introduced by the template-expansion work

### 1a. Nested options inside a dead branch are checked

- **Before:** inside a branch no configuration takes, a nested `!if` / `!switch` option
  the dead branch's baseline does not take is never checked, although
  `BRANCH_CASE_UNREACHABLE` says "It is still checked."
- **After:** one check per such nested option, at the dead branch with that option also
  forced and deeper options cut away; its findings are reported in no configuration.
  The unreachable-branch check gains the same forcings. A templated consumer under two
  nested dead branches is checked with both forced.
- **Verify:** a fixture — a dead branch holding `!if variables.flag1` whose untaken
  option carries a `CEL_TYPE_ERROR` and a `SCHEMA_VIOLATION` — reports both, in no
  configuration, in the whole analysis and under every `within`. It fails at the start
  of the work. Dead-branch check count = dead branches + untaken nested options
  (linear). A seeded fault that skips nested options fails the fixture. Second
  fixture: a templated consumer inside a literal-dead `!if` inside a dead branch,
  forwarding a value with a CEL type error, reported in no configuration. A seeded
  fault that forces only the outer option fails it. Expectations change only by newly
  found rows.

### 1b. A kind document as a whole-document branch is refused, not a crash

- **Before:** an `!if` / `!switch` whose whole-document branch is a `Telo.Definition`,
  `Telo.Abstract`, `Telo.NeedType` or `Telo.Import` makes `analyze()` throw `internal:
  the kind document Telo.Definition '<name>' varies between configurations`.
- **After:** the same refusal a declaration-position branch already gets for a kind
  document, reported at the branch; the kernel refuses the same document with its
  `ERR_` twin.
- **Verify:** fixture `Telo.Definition` under `!if variables.flag2` gives a diagnostic
  at the branch and no internal throw, whole and under either `within`. A
  `tests/check-run-agreement.yaml` row: refused at check, `runFails:` at run, the kernel
  code checked by running it. A seeded fault (refusal skipped) brings the throw back.
  The analyzer guide gains: "A kind document never varies — a choice inside one outside
  its template body, or one as a branch, is refused — so the kind-document enumeration
  is the same in every configuration."

## 2. One union verdict, and the step-union cost

### 2a. One outcome function over union branches

- **Before:** each caller of a union schema check (analyzer schema checks, the
  definition registry, the kernel's create-time validation, schema compatibility,
  throws coverage) attributes a union failure its own way: flat-list attribution,
  nested candidates, depth/count ranking.
- **After:** each `anyOf` / `oneOf` branch is validated on its own, for every
  applicator, and one outcome function over branch states (`valid`, `failing`,
  `shape-refused`, `tag-refused`) decides the verdict for every caller. The three
  attribution schemes are deleted.
- **Verify:** one unit row per outcome and per applicator (several `failing`, a `$ref`
  branch); kernel create-time tests and `tests/check-run-agreement.yaml` green;
  expectations change only by rows traced to the several-`failing` rule or exact `$ref`
  assignment, each listed old/new; a seeded fault (depth ranking among `failing`) fails
  the several-`failing` row.

### 2b. A step union's schema checks stop growing 2^N

- **Before:** a union site's schema verdict is keyed per member, so W has 2/4/8/16/256
  schema keys per site at N=1/2/3/4/8.
- **After:** one verdict class per (cut site, schema node); per-branch verdicts folded
  worst-of, never per member; selection on member keys; cut-away stand-ins excused in
  the union's own judgement. Builds on 2a.
- **Verify:** V, W and S at N=1/2/3/4/8 — schema keys ≤ 2 per site, the site naming
  `sequence` and S's Application site at 1 key; own(8)/own(4) ≤ 2.5 and own(4) ≤ 2 ×
  own(2), with W and S shown failing first. New bench row Wf (the outer `try` union
  site) has equal keys at N=2/4/8. Seeded faults fail the differential on
  `step-union-member-choice.yaml` and `step-union-choice.yaml` (recorded first); a
  per-member class fault makes Wf grow from N=4 to N=8. Expectations unchanged except
  the new fixture.

## 3. Every remaining check runs once over all configurations

Each step keeps expectations unchanged and the differential green. Each converted pass
is counted running once on S at N=4.

### 3a. Referrer rules and catalog sets

- **Before:** resource rules are judged once with conditions; referrer rules and
  catalog-set duplicates still run inside each configuration. A presence test
  `has(a.b)` is read as a read of all of `a`, so for `a = self` it depends on the whole
  declaration. Resource rules work around this.
- **After:** referrer rules (anchored at the reference slot and each `peers:` entry's
  slot, `resolve:` targets one level past) and catalog sets (anchored at the marked
  node) are judged once with conditions. Remaining fallback reads in rule conditions are
  replaced: a chain read follows `cel.bind` and comprehension variables, and `this`
  through a repeated group reads the list. The shared CEL read-chain reader records
  `has(a.b)` as a read of `a.b`, and the resource-rule workaround is deleted.
  `RESOURCE_RULE_SKIPPED` / `REFERRER_RULE_SKIPPED` are reported per instance.
- **Verify:** zero rule or catalog-set evaluations inside configuration runs (counted).
  Fixtures `referrer-rule-resolve-choice.yaml`, `referrer-rule-peers-choice.yaml` and
  `catalog-set-choice.yaml` (the read member, or the duplicate a reference brings in,
  under `!if variables.flag1`), each with a seeded fault that drops its places and
  fails the differential. Rule and catalog padding rows are flat in padding size.
  A rule reading a varying member gets one schema key per site. A rule whose condition
  is `has(self.x)` is unaffected by a choice on another field.

### 3b. References, absence and mark reach

- **Before:** four whole-set passes run with conditions (module-level duplicates,
  unused declarations, module-level `SINK_UNATTACHED`, `OBSERVED_STATE_REQUIRED_FORBIDDEN`).
  Reference checks, rule-unexercised warnings, sensitive / span-attribute reach,
  scope-member duplicates and scoped sinks still run per configuration.
- **After:** these also carry conditions:
  - `UNRESOLVED_REFERENCE` / `REFERENCE_KIND_MISMATCH` / `INVALID_REFERENCE`,
    `x-telo-schema-from` and `SCOPE_ENTRY_NOT_INLINE` — keeping alias gating, stand-ins
    and the out-of-reach wording.
  - `RESOURCE_RULE_UNEXERCISED` / `REFERRER_RULE_UNEXERCISED` hold where the rule's
    condition holds and no instance exercised it.
  - Sensitive / span-attribute marks reach only where the contract reaching them is
    present.
  - Scope-member duplicates and scoped sinks.
- **Verify:** each pass counted once on S at N=4. Mark-reach fixture: a mark in a named
  shape whose only reaching contract is under `!if flag1`, labelled `(when
  variables.flag1 is false)`; an unconditioned-reach fault fails the differential.

### 3c. Edge passes

- **After:** call graph, cycles, throws union and coverage, rethrow placement, zones
  and durable regions carry conditions. Zone requirements and `x-telo-provides-zone`
  are built from declared reads (correlation-key places past references).
- **Verify:** the S cycle is reported once. Fixture: a correlation member past a
  reference chosen by `!if variables.flag1`; dropping that place fails the differential.

### 3d. Remaining relational passes

- **After:** the need table, resource inputs and optional references, shared-library
  conflicts, template body and forward checks, and texts carry conditions.
- **Verify:** as 3b.

### 3e. Template definitions and requiredness

- **After:** template-definition findings are conditions over the choices they depend
  on, with no loop over variants. Library input requiredness and "required in" reports
  are conditions rendered through the same cover.
- **Verify:** definition timing is flat at N=1/8/16. A row with 16 structural choices
  grows linearly. "Required when" outputs are unchanged.

### 3f. Delete the per-configuration loop

- **Before:** the analysis enumerates configurations and re-runs unconverted checks in
  each.
- **After:** no code iterates configurations: the per-configuration loop, the
  unreachable-branch loop and configuration enumeration in choice reading are deleted.
  `docs/guides/choosing-by-configuration.md`'s no-cap paragraph states the cost model,
  and the analyzer guide's *Choices and configurations* text is rewritten to match.
- **Verify:**
  - V and S: t(8)/t(4) ≤ 2.5 and t(16)/t(8) ≤ 2.5.
  - `telo check` at N=16 ≤ 2× N=1.
  - A cold `telo run` at N=8 ≤ 2× N=1.
  - The signature bench at or under 188/183/315/557 ms.
  - `within` at the first full configuration ≤ the whole analysis at N=1/4/8/16.
  - Expectations unchanged; differential green.

### 3g. A census site per alternative at one written place

- **Before:** when a declaration writes several alternatives at one place, the relation
  census keeps the first and skips the rest. No fixture shows a lost finding yet.
- **After:** a fixture with two alternatives at one written place. If it loses a
  finding, the site is keyed by option conditions, as forward views already are. Facts
  for a CEL site are matched only within the site's own declaration, which a fixture
  pins.
- **Verify:** the fixture's finding is reported in exactly the configurations taking
  each alternative.

## 4. Template-body gaps

### 4a. A template's `inputs:` against an entry contract derived from the entry

- **Before:** `TEMPLATE_TARGET_MISMATCH` is never reported when the dispatched entry
  kind's `inputType` is `x-telo-value-schema-from` / `x-telo-schema-projection-from`
  over the entry (the `ui` kinds' `inputType: { x-telo-value-schema-from: inputModel }`).
  `model: !ref Count`, a crossing `/model/shape` into a module declaration, and `model:
  !ref <sibling entry>` all pass with a refused value.
- **After:** the call site's contract resolution resolves the entry's references through
  the template body's own lookup (siblings, then the defining module, `<Alias>.<name>`
  through its imports). The static slot check and the kernel's creation-time decode of
  `inputs:` change together.
- **Verify:** a generated fixture with the three forms, each `inputs:` writing a refused
  value, reports `TEMPLATE_TARGET_MISMATCH` at `inputs.<field>`; none at the start. A
  `tests/check-run-agreement.yaml` row: refused at check, `runFails:` as the kernel
  prints it. Run the kernel side first to confirm what it refuses today.

### 4b. A body entry's reference to a resource of the wrong kind

- **Before:** a `Telo.Definition` whose `resources:` entry holds `src: !ref thing`,
  `thing` a `Self.User`, where the slot's `x-telo-ref` wants `Self.Thing`, passes
  `telo check`.
- **After:** `REFERENCE_KIND_MISMATCH` at the entry's slot, as for a top-level
  declaration.
- **Verify:** fixture reports it; a `tests/check-run-agreement.yaml` row records what
  the kernel does at creation.

### 4c. Resource rules over a forward view see the whole entry

- **Before:** a templated graph-store wrapper declaring a default bookkeeping table
  gives four `RESOURCE_RULE_INVALID` warnings ("no such key 'nodes'") instead of
  `GRAPH_TABLE_NOT_IN_SCHEMA`: the rule sees only the forwarded fields.
- **After:** a rule judged on a forward view reads the entry as the consumer
  instantiates it — forwarded values, body literals, and schema defaults the consumer
  left out.
- **Verify:** the wrapper fixture reports `GRAPH_TABLE_NOT_IN_SCHEMA` and no
  `RESOURCE_RULE_INVALID`.

### 4d. `self` in a body step's `value:` is typed, and matches run time

- **Before:** `self.<field>` is `dyn` in a template body step's `value:`, so `self.n *
  10` with a `number` field is never a `CEL_TYPE_ERROR`. It was also recorded that
  `self.<integer field>` arrived as a double while check typed it `int`
  (`self.factor * 10` failing at run); the loop's declared-integers fix targeted that,
  and it is unconfirmed whether it closed it.
- **After:** `self.<field>` in a body step's `value:` is typed from the definition's
  schema, and the value the kernel binds has the declared representation.
- **Verify:** `self.n * 10` with `type: number` is `CEL_TYPE_ERROR` at check; with
  `type: integer` it checks and runs (an `Assert.Equals` on the result). The integer
  case runs on today's tree first; if it already passes, it becomes a pinned row with
  no code change.

### 4e. A library kind's schema may `$ref` the library's own named shape

- **Before:** a library kind whose `schema:` `$ref`s a named shape declared in the same
  library fails `telo check` with `SCHEMA_COMPILE_ERROR: can't resolve reference
  telo:<Lib>/<Shape>`. Modules avoid it by using the shape only in `inputType`, and it
  blocks an end-to-end import test of the kernel's configuration view.
- **After:** the reference resolves at check and at boot.
- **Verify:** a library fixture whose kind's `schema:` `$ref`s its own shape, imported
  by an application: `telo check` clean, `telo run` boots. Then add the end-to-end
  import test of the kernel's configuration view that this blocked.

## Order

1 → 2a → 2b → 3a → 3b → 3c → 3d → 3e → 3f. 3g fits anywhere before 3f. Part 4 is
independent of the rest, and 4e unblocks the configuration-view import test.
1a and 1b land before 3f.

## Release

- One changeset for the telo version line (analyzer, kernel, templating), extended per
  part; the new refusals are named in it. No new manifest syntax, so no `requires:`
  floor.
- `docs/reference/diagnostics.md` rows for new or reworded refusals.
- `analyzer/nodejs/CLAUDE.md` and `kernel/nodejs/CLAUDE.md` updated where the
  mechanism they describe changes.
