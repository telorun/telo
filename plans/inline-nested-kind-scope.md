# A nested declaration is analyzed as part of the wrong resource

## Problem

**A manifest that `telo check` accepts fails at boot, the manifest that would work is rejected,
and a whole class of per-resource checks silently does not run.** Verified by execution, in two
shapes: an inline declaration at a step's `invoke:`, and a named declaration in a `with:` scope.

A nested declaration is its own resource, and the kernel treats it as one — it validates its
config, binds its contract and evaluates its CEL in *its own* scope. The analyzer treats it as
configuration of the **enclosing** resource.

**Direction one — a reference to an enclosing step passes `telo check` and fails at boot:**

```yaml
- name: inner
  invoke:
    kind: Run.Projection
    collection: !cel "steps.rows.result"   # accepted by telo check
    steps: [ { name: keep, value: !cel "item" } ]
    outputs: !cel "item"
```

```
$ telo check …   ✓  No issues found
$ telo …         error  Run.Projection SequenceMainSteps1Inner:
                 Expression ${{ steps.rows.result }} failed: Unknown variable: steps
```

`steps` is not merely missing the name — it is unbound entirely in the nested resource. The same
expression in a `with:` entry behaves identically (`error Run.Iteration scoped: … Unknown
variable: steps`), so the defect is not about being inline.

**Direction two — a reference to the nested body's own step is rejected**, and the message offers
the enclosing sequence's step names as the alternatives:

```
error  Run.Sequence/main: !cel at 'steps[1].invoke.outputs':
       'steps.keep' is not defined (available: rows, inner)   CEL_UNKNOWN_FIELD
```

`rows` and `inner` are the *enclosing* sequence's steps; `keep` is the only step the nested kind
has. The `with:` twin reports at `with[0].steps[1].inputs.output`. `telo run` performs the check
first, so this direction blocks the run outright.

**The CEL scope is the visible part; the rest of the analysis is second-class too.** Two checks
are switched off wholesale for any path below a nested `{ kind }`, on one shared test: unknown
CEL roots are not reported, and a `!cel` in a field that is never evaluated is not reported. The
test is right about the intent and wrong about the facts — its stated reason is that the nested
declaration "is analyzed again, in its own scope, as the resource it was extracted into", which
is true only where extraction reaches, and extraction reaches neither of these two shapes.
Everything else keyed to a field's eval mode — observed state read in a startup field, a
non-deterministic call baked in at load — reads that mode from the *enclosing* kind's schema, so
it answers for the wrong kind. Measured, on a nested body containing both a mis-named step input
and a typo'd binding:

```
$ telo check …   ✓  No issues found
```

The identical mis-named input one level up is an error today
(`CONTRACT_INPUTS_MISMATCH … 'outputTypo' is not allowed`).

**The two shapes are not equally bad.** A step's inline `invoke:` *is* schema-validated
(`inline Run.Iteration at 'steps[0].invoke': / is missing required property 'collection'`), and
gets its `x-telo-value-schema-from` companion, because the nested-config validator walks the
declaration in place. A `with:` entry gets **nothing**: the same missing required properties on a
scoped declaration are reported nowhere, and the kernel rejects it at create time instead.

**What it costs.** The inline form is the cheap shape the step grammar is supposed to offer — a
body kind used once, with no `metadata.name` and no `inputType:`. Today an author reaching for it
writes the natural expression, sees it pass, and gets a boot failure; the workaround they land on
is a named resource with a hand-written `inputType:` schema, which is the ~22-line shape the
inline form exists to retire. So the defect does not merely mis-report — it steers authors away
from the feature, and it leaves everything written inside the feature unchecked.

**The boundary is two slots, not one kind.** Analyzer-side extraction is driven by the reference
slot map, entry by entry, and only for reference entries. Every nested declaration that map
reaches becomes a resource of its own and is analyzed as one. The two it does not reach are a
step's `invoke:` — the map stops at the shared step fragment deliberately, because the kernel
injects through that same map and a step's target must resolve at dispatch — and a scope slot,
whose contents it records and does not enter.

## Solution

**A nested declaration is analyzed as a resource of its kind, wherever it is written.** That is
what the kernel does, so the analyzer is the half that changes; the rule is one sentence and its
consequences run through several passes, which is the point rather than an accident.

The rule already exists for the neighbouring case: a `resources:` entry in a `Telo.Definition`
template body is treated as a declaration of its own kind, and CEL inside it resolves through
*that* kind's own annotations. A declaration at a step's `invoke:` or in a `with:` scope is the
same shape reached by different routes, and those are the routes that did not take the rule.

### 1. One reader for nested declarations

**Before.** Two mechanisms answer "is there a nested declaration here", neither of them
completely: the reference slot map (which reaches neither shape) and a flat list of template-body
prefixes, matched first-hit, built only for a definition's `resources:`.

**After.** One reader answers where the nested declarations are, at what path, and of what kind —
across all three routes (a template body's entry, a step's `invoke:`, a scope entry), **recursing
into what it finds**, since an inline body's steps carry inline bodies and a scope entry has a
step body of its own. Path matching is **innermost-wins**: a flat first-hit list answers the outer
body for a path inside the inner one, which is the same bug one level down. It is the single
reader for the CEL scope rule, the nested-config validator and the editor's scope query, which is
what keeps a completion offering names that `telo check` will accept.

**Verify.** A body nested two deep resolves against the innermost declaration; the enclosing
declaration's names are not offered there; the reader answers identically for a step's `invoke:`
and for a `with:` entry; the editor's query and the check agree at the same path.

### 2. Analyze a nested declaration as a resource of its kind

**Before.** A nested declaration's CEL is typed against the enclosing resource's scope, and the
checks that would have caught the difference are switched off or ask the enclosing kind.

**After.** Each pass takes the nested declaration's own kind at the reader's path:

- CEL roots and members resolve in the nested kind's scope — its context regions, its step body,
  its error branches.
- Unknown-root reporting is on inside a nested body, keyed on the nested kind's scope rather than
  suppressed by a path test.
- `CEL_IN_NON_EVAL_FIELD` and everything else derived from eval mode read the **nested** kind's
  eval sites.
- A nested body's own step call sites are checked against the invoked target's contract.
- Schema validation and `x-telo-value-schema-from` reach a `with:` entry, as they already reach a
  step's inline `invoke:`.

**Analyzed in place, not extracted.** Extraction would deliver these passes by construction, and
it is what the kernel does for a step's `invoke:` — but the kernel generates that name at dispatch
by its own recipe, so an analyzer that extracts either matches a name it does not own or reports
under a second one; and a `with:` name is scope-local, so promoting it to a module-level resource
would make a scoped name resolvable from outside its scope. In place, the declaration keeps the
path the author wrote, which is also what keeps every diagnostic anchored without remapping.

**Verify.**

- Direction one reports `steps.rows` as undefined at `steps[1].invoke.collection`, naming the
  nested kind's own step names as available; the `with:` twin reports at `with[0].collection`.
- Direction two resolves and runs, in both shapes.
- A nested kind's own bindings (`item`, `index`, `inputs`) resolve, and `item.noSuchField` —
  accepted today, a boot failure today — becomes an error.
- A mis-named input at a nested body's step is `CONTRACT_INPUTS_MISMATCH`, as it already is one
  level up; a `with:` entry missing a required property is `SCHEMA_VIOLATION`, as an inline one
  already is.
- The kernel globals still resolve inside a nested body: a body reading `variables.greeting`
  checks clean and still prints. This is the regression the rebase can plausibly cause.
- A `!cel` naming nothing in either scope is reported once, not twice.

### 3. Say how a value crosses the boundary

The boundary is real and the diagnostic should point at the way across it rather than only at the
failure: a step's sibling `inputs:` is what carries a value into a nested kind, and the nested
kind reads it as `inputs.<name>`.

```yaml
  - name: inner
    invoke:
      kind: Run.Projection
      collection: !cel "inputs.rows"        # resolves in the nested scope
      steps: [ { name: keep, value: !cel "item" } ]
      outputs: !cel "steps.keep.result"
    inputs:
      rows: !cel "steps.rows.result"        # resolves in the enclosing scope
```

The crossing itself already works today; the nested `outputs:` line is direction two and starts
working with §2. Two conditions on the hint, both because a suggestion that does not apply is
worse than none: it fires **only when the unresolved name resolves in the enclosing scope**, and
**only for a declaration reached through a step**, since a `with:` resource started from
`targets:` has no argument slot to cross by — there the diagnostic reports the name and stops.

**Verify.** The manifest above checks and runs; the broken form's diagnostic mentions the step's
`inputs:`; a name that resolves in neither scope gets the plain `CEL_UNKNOWN_FIELD`; the
`targets:`-started `with:` shape gets no crossing suggestion.

### 4. Tests, and the documentation the rule lives in

`modules/run/tests/iteration-inline-step.yaml` covers the working shape today. Around it:

- `Assert.Manifest` fixtures for what is newly rejected — direction one in both shapes, a
  nested body's mis-named step input, a `with:` entry missing required config — pinning the code
  and the nested kind's own names in the message.
- Runtime tests for what is newly accepted: direction two in both shapes.
- A runtime test reading a kernel global from inside a nested body.
- The run guide and that test's description state the semantic rule — the nested kind is its own
  resource, so the enclosing `steps` is not bound inside it, and the step's sibling `inputs:`
  carries the value across. **That rule is what this change enforces, so both passages stay.**
  What goes is the one sentence in each that records the gap ("currently passes `telo check` and
  then fails at runtime", "`telo check` currently accepts the latter"), replaced by what changed:
  the boundary is now caught statically and the diagnostic names `inputs:`.

Release: `.changeset/`, `"@telorun/analyzer": minor`, plus a `.changes/` fragment for
`modules/run` (its docs and tests change).

## Decisions

- **The kernel is right and the analyzer changes.** A nested declaration genuinely is its own
  resource; binding the enclosing resource's `steps` into it at runtime would mean a nested kind's
  meaning depends on where it was written, and would give one name two referents wherever a
  nested step shares a name with an enclosing one. The runtime half of direction two is verified,
  not assumed: hand-extracting the nested body into a named resource — the shape the runtime
  constructs for it — checks clean and runs.
- **Scoped by the declaration, not by the slot and not by the kind.** One reader, three routes,
  recursive, innermost-wins — so a third-party composer is covered the day it ships, and depth is
  covered by construction rather than by a rule that happens to hold at one level.
- **This is a fix, not a migration, and it changes acceptance in both directions.** No manifest
  can depend on direction one, because it never ran. What newly *fails* `telo check` is a manifest
  that passes today and is already wrong: a typo'd binding inside a nested body (a boot failure
  today), a mis-named step input there (a contract failure at dispatch), a `with:` entry missing
  required config (rejected by the kernel at create time), a `!cel` in a nested field that is
  never evaluated (read as a literal today), and the eval-mode warnings that come with reading the
  right kind's annotations. Every one of them is a defect the analyzer was blind to, not a working
  manifest being taken away — that is why the fix is worth the new rejections, and why they are
  listed rather than discovered by whoever upgrades.
- **No `requires:` floor for the fix; one for whoever adopts what it accepts.** The change widens
  no syntax, so nothing needs a floor to load. A *module* manifest that later adopts the
  newly-accepted shape does need one — an older analyzer reading that file rejects it with
  `CEL_UNKNOWN_FIELD` and blames the module's author — declared at the release that carries the
  fix and verified by running the previous published CLI against the file.
