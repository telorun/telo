# Declared runtime requirements

## Problem

**Additive syntax is not additive to a closed vocabulary.** Telo closes every extension
vocabulary and hard-errors on an unknown token — right for a typo, wrong for a version, and the
checker cannot tell them apart because a name is only a string. A module that adopts new syntax
therefore breaks on every older runtime, and blames the wrong party while doing it.

The durable-execution plan supplies two live cases. `x-telo-provides-zone` gains an object form:
`validate-zone-slots.ts` reports it as `ZONE_ANNOTATION_INVALID`, and `readProvidesZone`
(`zone-slot.ts`) returns undefined for it, so `zone-context.ts` raises
`ERR_ZONE_ANNOTATION_MISSING` — *"the controller and its schema disagree"*, a statement about the
module author when the truth is a version skew. A step gains `timeout:`; `InvokeStepSchema` in
`manifest-schemas.ts` is closed, so one new key is a schema violation. The same shape sits behind
`use` tokens, `x-telo-type` names, `KNOWN_CAPABILITIES`, the value-type binding table, manifest
fragments, and any new built-in doc kind.

Nothing stops a consumer walking into it: `telo upgrade` selects the highest published version
unconditionally, and no manifest carries anything a resolver could filter on.

## Solution

A module declares, in a top-level `requires:` block, the range of runtimes it is verified
against — and the claim is verified by *running* those runtimes.

**The declaration is a requirement, not a build fact**, which is what lets it gate. A derived
"built with 0.80" stamp cannot: every republish restamps, and most modules built on a newer
toolchain use none of its new syntax, so gating on it would reject modules that work.

**Landing the block is itself a breaking surface change, and there is no way around it.**
`Telo.Application` and `Telo.Library` carry closed schemas in `builtins.ts` — it is their
`metadata` that is open, not the document — so a manifest declaring `requires:` is a
`SCHEMA_VIOLATION` on every analyzer released before this one. The block is added to both
schemas here; older runtimes cannot be taught to tolerate it retroactively.

That is the mechanism's own problem, arriving one release early: the first module to declare a
requirement is unreadable to an older telo *with an unexplained message*, which is exactly what
this exists to stop. It is unavoidable and it is the last time it should happen unexplained — from
the release that ships the block onward, the gate names the cause. A migration entry cannot help:
migrations rewrite a legacy spelling into the current one, and there is no older spelling of a
key that did not exist.

Two consequences. The sequencing below is not a preference but a correctness requirement — the
standard library must not declare ranges until the release carrying the schema change is the one
consumers are on. And it is a further argument for `telo upgrade`'s filter, which is what keeps a
consumer on an older telo away from the versions that declare anything at all.

### Range grammar

Each axis is a semver range whose every bound is testable, which two rules make true.

`^` and `~` are rejected at parse. On 0.x both mean a single minor, and this repo ships breaking
changes as minors deliberately, so the caret reading is *correct* and therefore useless — every
module would pin to one breaking-change generation and nobody could move telo without the whole
standard library republishing. It is also the spelling semver intuition reaches for first, so the
failure would be common and silent; the diagnostic names the trap rather than reinterpreting it.

A declared upper bound must name a version that already exists, verified in the publish
preflight. Open above is therefore the norm, and what a closed bound is genuinely for is the one
case it earns: a module known broken on a newer telo that will not be fixed. Publishing a patch
bounded below that release makes `upgrade` report *no compatible version* instead of handing a
consumer a confusing failure.

### Verification

The CLI is run at each edge of the declared range over the module's own manifest. Green means the
declaration is true; red at the low edge means new syntax was adopted, red at the high edge means
something since removed was used. This is not a prediction of the property — it *is* the
property, executed — so nothing has to be annotated and nothing can drift out of sync.

Two edges bound the whole range rather than sampling it, because syntax support is monotonic: a
construct added in 0.43 works in 0.44 and later, one removed in 0.60 works in 0.59 and earlier.
For an open range the high edge is HEAD, which normal CI already checks, so an open declaration
costs one extra run and a closed one costs two. `release check` groups modules by shared edge and
issues one invocation per distinct edge across the workspace; `@telorun/cli` is published, so
every historical edge is installable.

Transitive propagation is free: in-repo modules import siblings by relative path, so a sibling
adopting new syntax fails its dependents' own checks until their ranges move. Nothing walks a
graph — the check is the walk. The failure direction is safe: an old CLI failing for an unrelated
bug fixed since raises a lower bound that did not strictly need raising, which costs precision
and nothing else.

### Where it is read

**The analyzer owns the mechanism because the editor validates in the browser.** A new
`requires-block.ts` is the single reader — the `ref-slot.ts` / `zone-slot.ts` precedent — owning
the parse rule, the comparison, the axis ordering and the `MODULE_REQUIRES_NEWER_RUNTIME`
diagnostic. It is raised per module during `loadGraph`, before that module's validation, so the
version message wins over the vocabulary error it would otherwise be buried in, and an app
importing twelve modules where one is too new gets one message about that one and ordinary
diagnostics for the rest. The kernel consumes it as it already consumes the analyzer's loader —
no second implementation.

The CLI owns only what is Node by nature. `publish` runs edge verification as a preflight, which
is what makes the claim near-fact for third-party modules rather than only as honest as each
publisher's CI. `release check` runs the same function over the workspace; it is already the
modules-in-a-workspace gate and this is a module-level claim, so it needs no new verb, and a
third party without `telo-workspace.yaml` still gets the check at publish.

`upgrade` selects the highest version whose range accepts the running version, walking candidates
newest-first and stopping at the first satisfied one — so the common case costs a single manifest
fetch, and the manifest is its own artifact layer, so no payload is pulled. It must report what
it held back, or the pin becomes a silent ceiling and *"up to date"* is the new confusing report;
when no candidate's range accepts the running version it says so rather than reporting the module
as current, which is the abandoned-module case the upper bound exists for.

### Version identity

**The analyzing runtime answers "what version am I?"** — the only well-posed question in a
browser, where no kernel is running and the editor is authoring for a target that is not present.
Checking against itself is also exactly what the editor needs: a manifest requiring 0.90 opened
in an editor shipping 0.85 produces vocabulary errors the editor cannot otherwise explain.

A `telo-version.ts` constant is generated at build from the linked kernel/cli/sdk version — the
pattern `copy-value-type-entries.mjs` and `copy-migration-entries.mjs` already establish for
feeding data to the browser-safe analyzer — and is overridable through `AnalysisOptions`, which
`StaticAnalyzer` already carries. The kernel and CLI pass their own version, since they know
which runtime will actually execute; the editor takes the default. Defaulted rather than
optional, so there is no "caller forgot, check silently skipped" path.

### Who declares

Libraries declare always and open above. The lower bound then moves only when verification forces
it, so the standing value is whatever release the module was last verified against — the
declaration reads as *"the oldest runtime we support and test"* rather than *"the absolute oldest
that would work"*, which is the meaning that makes the mechanism enforce anything. Declaring only
on adoption was rejected: nothing verifies an undeclared module, so the first adoption is exactly
the case that slips through.

**An application's requirement is not derivable from its imports.** The effective minimum for
running one is the maximum of its own syntax and every transitively imported module's
declaration; the imports half never needs computing, since each is checked where it is declared
as the graph loads, but the app's own half is visible nowhere else. What differs is the
*consumer*: nobody imports an application and it is never a resolution candidate, so its block
buys only a version-attributed message for its own operators plus the CI hook. Declaring is
therefore optional and recommended for anything distributed — most of all `templates/apps/*`,
the one app-shaped thing with real distribution. Grammar and reader stay identical across doc
kinds; a block parsing differently by kind would be a second rule to keep in sync forever.

No consistency rule is needed between an app and its imports. An app declaring a lower bound than
one of its imports is *incomplete*, not false, and verification catches it regardless — checking
that app at its low edge loads the import and fails. The same reasoning covers a library
importing a newer library.

### One `telo` scale across every kernel

**A Rust or Go kernel does not get its own range.** The surface generation is the shared scale:
each kernel's crate or module version is its own release identity on its own cadence, while the
generation it *implements* is a separate number every kernel reports — the same split already
made for the analyzer, generalized. `telo: ">=0.80.0"` then means one thing everywhere, and
per-kernel ranges would restate one fact three times with a guarantee of drift.

Per-kernel ranges also fail on their own terms. An author writing bounds for kernels they have
never run is asserting the unverifiable, and no CI can edge-verify every kernel at every edge —
which is precisely what the range rules exist to forbid.

**A kernel implementing only a subset of a generation claims none, and skips the check.** A
version scalar expresses *older*, not *smaller*, and `kernel/rust` today is a deliberate subset —
`Telo.Invocable` only, local-path imports, no CEL — which is not a lower generation. Guessing a
generation it partly implements would produce confidently wrong messages, worse than none. This
costs nothing today, because that kernel cannot load a published module at all; it becomes
relevant exactly when convergence lets it claim a generation, and at that point the scalar is
correct. The premise is that the kernels converge — if they were meant to stay permanently
different subsets, cross-kernel compatibility would need feature-level capability declaration
instead, which is the deferred tolerance design.

**Runtime reach stays derived and separate.** Which kernels can host a kind already follows from
its `controllers:` PURL candidates, per kind. `requires:` must not restate it — a second declared
copy of a derived fact would be wrong the day a loader lands.

### Host axes

Host requirements nest under `host:`, a sibling of `telo:`, holding `node`, `rustc` and later
`os` / `arch` / `libc` — the vocabulary `ArtifactSelector` already uses, so a future axis has an
obvious home rather than a naming argument.

**Nested to disambiguate by position.** `nodejs` and `rust` are already *kernel labels* in this
repo (`LABEL_TO_PURL_TYPE`, the `imports:` entry's `runtime:` field), so a top-level `node:` reads
as the Node kernel rather than the Node.js runtime, and no word escapes that — the host runtime
and the kernel implementation genuinely share a name. `rustc` escapes it only because no kernel
is called rustc. Under `host:` nothing has to: position carries the disambiguation.

**The tiers also differ in how they are verified**, which a flat map would hide. `telo` is the one
axis verified by *execution* — run the CLI at each edge. A Node version cannot be edge-verified
that way; host axes are asserted by the author and compared against the machine at the point the
requirement bites, a `rustc` bound when a Rust controller is built rather than when the manifest
is read. So their enforcement belongs to the slice that adds them; the analyzer owns reading and
ordering them, since the block is one grammar, and the editor legitimately reports neither.

**Ordering is normative: `telo` is checked before `host`.** A module using an axis introduced in
telo 0.85 also declares telo `>=0.85`, so a 0.80 runtime fails on the telo axis first and never
has to decide what an axis it has never heard of means. Once `telo` is satisfied an unrecognized
key is an error at either tier, because a runtime at or above the declared generation is expected
to know every axis that generation defines. Every axis shares one grammar — a semver range, no
`^` / `~`, upper bounds only where they already exist — so there is one parse implementation.

## Sequencing

1. `requires:` parsed and enforced at load (analyzer, consumed by kernel, IDE and editor);
   verification in `publish` and `release check`; `upgrade` filtering with its held-back message.
2. The standard library republished once, every library declaring the then-current range;
   `templates/apps/*` and the distributed applications declaring in the same pass.
3. Only then may zone attributes — or any other vocabulary change — land.

Step 2 cannot be skipped and cannot be done retroactively: a version that carries new syntax
while declaring nothing leaves old runtimes exactly where they are today. Absent means no
requirement, permanently, for everything published before it — correct rather than a concession,
since none of it uses syntax that does not yet exist.

## Limits

- **It does not make anything work.** An old runtime cannot execute semantics it lacks; this makes
  the failure early, singular and correctly attributed. Tolerating unknown-but-optional syntax — a
  criticality marker per construct, in the shape of X.509's critical bit or JSON Schema's
  `$vocabulary` — stays available if these messages prove insufficient, and is deliberately not
  built now.
- **It does not protect this repo.** In-repo modules import by relative path with no version and
  always run head. This is consumer-side.
- **A third-party module with an absent or wrong declaration** still produces the confusing
  failure. The publish preflight shrinks that set; nothing closes it.
- **Granularity is per module.** One kind adopting one construct raises the floor for every
  consumer of the whole module — the honest unit, since a module is one artifact, at the cost of
  gating a consumer on a kernel upgrade they may not otherwise have needed.
- **The "one scale every kernel reports" axis is, today, defined and verified inside npm.**
  `TELO_SURFACE_VERSION` is generated from `cli/nodejs/package.json`, verification runs
  `npx @telorun/cli@<edge>`, and the upper-bound existence check queries the same npm package.
  Reading all three from ONE package is the most that can be fixed here — it removes the drift
  between the constant and the check — but a Rust or Go kernel has no npm coordinate and no way to
  run that verification, so the axis the design calls kernel-independent is currently anchored in
  one language's registry. Closing it needs a registry-neutral way for a kernel to publish and
  prove the generation it implements, which is a separate slice.
- **A skew that surfaces during LOAD cannot be explained by the gate.** `validateRequires` runs
  inside `analyze()`, after `loadGraph` has parsed, migrated and precompiled. New syntax that is a
  *tag* rather than a key — a new templating engine, a new sentinel — fails in the loader before
  `requires:` is ever read, so those manifests still fail unexplained. Moving the check into the
  loader would buy that shape at the cost of reading a partially-understood document to decide
  whether it can be read at all; the honest fix is for a new tag to arrive with a loader that
  tolerates an unknown one long enough to reach the gate, which is the deferred tolerance design.
- **Only `node` is an enforced host axis.** An axis enters the vocabulary when a supplier exists,
  never before: a declared requirement nothing compares is the failure class this mechanism exists
  to remove. `rustc` arrives with the slice that builds controller crates.

## Decisions

- **A declared requirement, not a derived stamp** — a stamp records what built the artifact, which
  moves on every republish and says nothing about what the module uses, so it cannot gate without
  rejecting modules that work.
- **Verified by running the old CLI, not by a `since:` annotation per vocabulary entry** — an
  annotation table re-creates the same discipline problem one level down, forgetting is silent
  again, and it cannot see a *shape* change without a second mechanism on the kernel-owned schemas.
- **Ranges, not bare minimums** — a bound naming an existing version is testable, which was the
  only real objection to the upper half; the minimum-only form was rejected once edge-testing
  showed both bounds can be executed.
- **`^` and `~` rejected rather than reinterpreted** — pre-1.0 they allow only one minor, the
  honest reading under this repo's minor-bump policy and also the spelling intuition reaches for
  first, so the failure would be common and silent.
- **Upper bounds must already exist** — a bound is declarable because it is testable; the thing it
  forbids, predicting a future break, is a claim nobody can make honestly.
- **Analyzer-owned, CLI-consumed** — the editor validates in the browser, and a compatibility rule
  implemented twice eventually disagrees about what a manifest means.
- **Version derived at build, not by folding `analyzer` into the linked version group** — the copy
  scripts already make the analyzer's build depend on sibling data, and separating package release
  identity from implemented surface generation says the truer thing without forcing churn.
- **Libraries declare always and open above; applications optional** — a library's block is a
  contract others resolve against; an application has no importer.
- **`telo` axis checked before any other** — a module using an axis introduced later also requires
  the telo version that defined it, so the block extends safely and an unrecognized axis after
  `telo` is satisfied is an error rather than a guess.
- **One `telo` scale across all kernels, not a range per kernel** — the surface generation is
  reported by every kernel independently of its own release identity; per-kernel ranges would
  restate one fact three times and demand bounds their author cannot verify.
- **A kernel implementing a subset of a generation claims none** — a version expresses *older*,
  not *smaller*, and guessing a partly-implemented generation produces confidently wrong messages.
- **Host axes nested under `host:`** — `nodejs` and `rust` are already kernel labels here, so no
  top-level word disambiguates the host runtime from the kernel; position does. The tiers also
  differ in verification (`telo` by execution, host by assertion), which a flat map would hide.
- **External tools are not this** — `requires:` is what must be true before telo can run the
  manifest at all; ffmpeg or puppeteer is a dependency of the work, unverifiable, unbounded, and
  carrying a per-platform install action. It belongs in a resource kind provisioned through
  `telo install`, where static analysis, per-resource granularity, the existing platform selector
  and a consent point all already exist.
- **Publish's existence check warns when the registry is unreachable** — it gates a bound absent
  from almost every module, and an unreachable npm should not block a publish.
- **No `DiagnosticFix`** — the repair is upgrading a runtime or moving a pin, neither of which is a
  whole-value replacement for one node.
- **The block is added to the closed module-doc schemas, accepting one unexplained break** — the
  documents are closed (only their `metadata` is open), so no older analyzer can be taught to
  ignore `requires:`; a migration cannot help, since there is no legacy spelling of a new key.

## Notes

- `requires:` on a module doc is unrelated to the `requires:` the durable-execution plan proposes
  on `Telo.ZoneAttribute` for attribute completeness. Different doc kinds, no collision, but the
  spelling is shared and both should stay aware of the other.
- The block is authored, so it is not a derived stamp and must not join `DERIVED_METADATA_FIELDS`.
  It is also not inside `metadata:`, so `module.<field>` never exposes it to CEL.

## Example after the change

```yaml
kind: Telo.Library
metadata:
  name: SQL
  version: 0.9.0
requires:
  telo: ">=0.80.0"
```

Once the host axes land, a module shipping a Rust controller declares them under `host:`:

```yaml
requires:
  telo: ">=0.85.0"
  host:
    rustc: ">=1.75.0"
```

A consumer on 0.76 running `telo upgrade` stays on the last version whose range accepts 0.76 and
is told that 0.9.0 exists and why it was held back. A consumer who pins 0.9.0 by hand is told, at
load, that `sql` requires telo `>=0.80.0` while this runtime is 0.76.0 — instead of meeting an
unexplained schema error inside a module they do not own.
