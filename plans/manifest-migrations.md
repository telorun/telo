# Manifest migrations

**Scope: core migrations.** Module-authored migrations are a second declaration surface over the same mechanism, named here so it is not shaped wrong, and planned separately.

## Problem

Telo rewrites a manifest between parsing it and analyzing it, in at least six places: `resolveRefSentinels`, `desugarImports`, `normalizeInlineResources`, `resolveSchemaRefKinds`, `rewriteSyntheticOrigins`, and `normalizeRefSlots`' drop of a legacy scalar `type` at a ref slot. They share no shape, no ordering rule, and no policy.

Two different things are tangled there. Most are **normalizations** — authoring sugar folded into the internal form, never written back to source, correctly invisible. But a growing minority are **migrations**: an old spelling rewritten to the current one because published artifacts carry the old and cannot be edited. `X_TELO_REF_LEGACY_IDENTITY` is one and does not even rewrite — it warns and leaves every reader carrying the legacy knowledge.

Each migration currently re-invents the same four things by hand: where to walk, how to report without blaming a dependency the author cannot fix, how an author is supposed to *act* on the warning, and when the migration may be deleted. The last two are usually skipped entirely — a deprecation warning today tells an author something is wrong and offers no way to fix it but hand-editing, and nothing records what would have to be true before the code could go.

The demand is smaller than it first looks, and sizing the framework against it honestly matters. The value-type keyword unification is a spelling rewrite and is the committed case. `exports.kinds` becoming private by default is **not** a migration at all — it is a default change that would have to synthesize a list from kinds declared in sibling documents. The `x-telo-ref` legacy string form and `X_TELO_REF_LEGACY_IDENTITY` both need to know which slots are ref slots, or which alias names a module, so neither is matchable before the definition registry exists. One committed consumer, then, and a framework that should be sized for it.

Three constraints bound any answer:

- **The loading path is polyglot.** `analyzer/rust/` mirrors the Node loader one-for-one (`manifest_loader.rs`, `parse_loaded_file.rs`, `resolve_ref_sentinels.rs`) and the Rust kernel reads manifests through it — but it is the *loading half only*, with no analyze pass. A rewrite added to one side means one artifact means two things on two kernels, invisibly, because a migration that succeeds is silent.
- **Diagnostics locate themselves through the raw file.** `resolveRange` looks a dotted path up in a position index built from the source, then falls back to the parent's key or *value* range. Every rewrite that exists today preserves paths; a key rename is the first that would not, and after it every downstream diagnostic on that node degrades to a parent squiggle — with a `DiagnosticFix` over a single-line parent value writing a whole value across it.
- **A module author has the same problem one boundary out.** Renaming a field on a kind they own breaks every consumer manifest written against the old name, and today there is nothing they can ship that fixes it.

## Solution

**A migration registry and one driver, in `analyzer/nodejs/src/migrations/`.** The entry set is data rather than code: one file per entry under `analyzer/migrations/`, consumed as one lexically ordered set, shipped in the published package and embeddable by the Rust crate at build time. Adding a migration is one file; retiring one is deleting it.

**A migration is a matcher plus a patch, and the two halves are at different maturities.** The **operations are declarative now**, and they are named for what they target: `rename-key`, `set-value`, `set-tag`, `insert-item`, `remove-entry`. Each carries one fixed parameter shape and no path of its own, since the matcher supplies the location. That earns its keep immediately, because **every operation has a known YAML edit form**: it is what makes a migration applicable to a file at all, and what lets the driver derive whether a quick fix exists — read straight off the verb.

The model is JSON Patch's (RFC 6902): a declarative edit as a short sequence of primitive operations over a document. The *names* are deliberately not, because the operations here are narrower than the standard ones and a borrowed name would over-promise — `move` relocates a value anywhere in a document across parents, while `rename-key` only ever renames within one mapping and refuses an occupied destination rather than replacing it. A lookalike wearing a standard's names invites expectations it does not meet, which is worse than an honest private vocabulary. What JSON Patch genuinely contributes, beyond the model, is the observation that it has no selection at all — which is precisely the half deferred below.

**The matcher grammar is deferred until a second entry.** Selection is what a migration needs and what the borrowed model has none of — a patch addresses a known pointer, while a migration must find *every* occurrence of a spelling — but a selector language is the invented half, and its two justifications are both deferred: portability is deferred with the Rust reader, and the closed-vocabulary-as-trust-boundary argument belongs to the module surface, which is out of scope. More decisively, **its requirements come from that out-of-scope surface**: a module migration must be data, and its selector shape is "fields of kinds I own". Designing the grammar now, on the evidence of one core entry, risks shaping it for the case that does not need it. So the first entry's selector is a predicate in code, and the grammar lands with the second entry or with the module plan, whichever comes first. That a rewrite needing alias scope or ref-slot knowledge is unrepresentable — which disqualified three candidates before anyone wrote them — came from analysis, and does not wait on a grammar to remain true.

A core migration whose *operation* does not fit is a signal to extend the operation set, never to hand-write a rewrite: that is the half whose portability and file-applicability the design rests on.

**The Rust reader and the normative spec wait for that same second entry**, and the deferral is safe for a stated reason rather than by hope: the only committed entry rewrites value-type annotations, which the Rust kernel does not observe — it is `Telo.Invocable`-only, has no CEL, and rejects `!include-bytes` outright. The divergence is inert today, not ignored. Portability is therefore a property the design *preserves* rather than one it fulfils now; when a migration lands whose effect is Rust-observable, the operation set is what makes fulfilling it a bounded job, and `kernel/specs/manifest-migrations.md` is where the contract goes at that point (the `module-artifact.md` precedent).

**Two declaration surfaces, one mechanism.** A **core** migration ships with the analyzer and may match any node; a **module** migration ships in a module's artifact and may match only fields of kinds that module owns. The distinction is **scope of match and provenance**, not code versus data — both are entries of the same shape, from different sources, aggregated by one driver. That is the `collectModuleFileClaims` factoring: engine claims and controller `path=` claims declared by different parties, read by one consumer that knows about neither. The closed vocabulary remains the trust boundary: a dependency can rename its own field in your manifest and provably nothing else.

**One phase, in the loader, immediately after parse and before `desugarLoadedFile`.** The driver invariant is that **a migration only ever matches author-written nodes**, and the position is what makes that structural rather than a convention. Desugaring appends synthetic `Telo.Import` manifests that deliberately have no YAML document — `documents` is left untouched so round-trip consumers can pair by index — and it carries each entry's `variables` / `secrets` *by reference* from the module doc's `imports:` map. A rule matching inside one would therefore have no edit target for `telo migrate`, would record a provenance path the author's file never had, and would be applied twice through the shared object. Nothing needs the later position: the `imports:` map is read straight off the module manifest and is equally available before desugaring.

Migrations still run before normalizations, and there the rule is load-bearing: the value-type keyword rewrite must precede name canonicalization. A second, post-resolution phase is deliberately *not* introduced. It would sit inside the analyze pass, which the Rust side does not have, so every entry in it would be structurally Node-only — reintroducing by construction the divergence the design exists to prevent — and it cannot be made safe by restricting such entries to analysis-only meaning, since the module migrations that motivate it change runtime meaning by definition. There is also reason to think it is unnecessary: attributing a kind to a module by alias needs only the raw `imports:` map, not the definition registry. Confirming that is the module plan's job. The phase is added when a migration genuinely needs registration, not before.

**Path provenance is part of the driver's contract.** Each rewrite records the legacy path it matched alongside the migrated one; diagnostics are remapped through that record before position resolution, and `telo migrate` reads its edit target from the same record — the location in the author's file, not the post-rewrite path. This is the generalization of `rewriteSyntheticOrigins`, which already rewrites `data.path` so position lookups resolve after `normalizeInlineResources` has moved a resource. Without it the framework ships a regression: every diagnostic downstream of a key rename loses its squiggle, and any fix among them writes across a parent's span.

**A migration's truth is a structural rewrite; `DiagnosticFix` is a projection of it.** That type is a whole-value `replacement` written over a value node's span, and `renderFixReplacement` deliberately refuses anything it cannot apply unreviewed. Most migrations rename a key or edit a collection, which it cannot express and must not be stretched to. So whether a quick fix exists is **derived from the operations**, not declared: a rule whose patch is a lone `set-value` changes a whole scalar and yields a fix that reaches the editor and CLI JSON, while anything containing a `rename-key`, `insert-item`, `remove-entry` or `set-tag` does not, and the diagnostic says so and points at `telo migrate`. The verb answers it on sight. The derivation is total, so a migration never silently lacks a repair — and nothing about it can be got wrong at authoring time, which a declared flag could be.

Applying a rewrite to a file is not a new mechanism either: `cli/nodejs/src/commands/manifest-imports.ts` already performs comment-preserving `Document.setIn` edits, which is how `install` / `upgrade` / `publish` rewrite the imports map. `telo migrate` applies each operation through that same document editing.

`telo migrate` is the **reference** application, not the only one: applying pending migrations is an *operation* other commands compose over a subset of entries. `telo upgrade` is the case that matters, since it breaks a consumer's manifest by moving a pin and should repair what it broke — applying the migrations of the modules it moved and nothing else, so a version bump's diff carries no unrelated churn. That composition belongs in the shared upgrade operation rather than the CLI command: `plans/pinned-import-upgrades.md` exists precisely because upgrade already had two front-ends emitting different YAML.

**A diagnostic composes in three parts, and the entry writes only the one nobody else can.** The driver knows the matched key and value, the replacement, whether a quick fix is derivable, and the location, so it generates *what changed* and *how to apply it* identically for every entry. What it cannot know is *why*, which is the part that makes a deprecation actionable rather than mysterious — so an entry supplies a `reason`, a sentence or two of rationale, never a clause of the generated sentence. That also keeps the field honestly entry-level: one entry may carry several rules, and a rationale is true of all of them where a mechanical description would have to vary per rule.

An entry also declares its stable **id** (so a diagnostic names which migration fired and docs can list them), its **diagnostic code and severity**, and its **reporting scope**: a migration *rewrites always*, because the runtime must read artifacts published years ago, but *reports only for the entry's own modules*, because a published dependency is not the consumer's to fix. That is the `X_TELO_REF_UNRESOLVED` rule, currently restated per-diagnostic.

An entry carries **no version stamp**. "Can this be deleted?" turns on whether any published artifact still carries the legacy spelling, which the artifact's own release version cannot answer — but the hub can, since it caches every tracked module version's `telo.yaml` and can be asked directly whether the old spelling survives anywhere. A stamp would record when an entry was written, which git already does, while looking like an answer to a question it does not address. Where a version does earn its place is the module surface, and not for retirement: `telo upgrade` composing a multi-version jump needs the newest artifact to carry the accumulated set, which is a question about what ships.

Because the phase is gated off for the editor's raw round-trip view — rewriting there would silently change the author's file on save — the loader's file-cache variant tag gains a migration axis alongside the existing compile and desugar ones.

**Composition is the driver's guarantee, not each entry's proof obligation.** One pass, with the match set frozen against the pre-migration tree, so no rule can match a node another rule produced. Rules within an entry apply in order at each match; entries are independent and never see one another's output — which matters once core and module entries are aggregated from different parties, where "it happens to work" is not determinism. Idempotency then follows from the driver rather than from every author getting it right: a rule matches only the legacy spelling, and re-running finds nothing.

A migration that **cannot** rewrite leaves the node untouched for the ordinary validator to reject, rather than guessing or dropping it. Two cases qualify: a malformed legacy value, and a `rename-key` whose destination already exists — which refuses rather than overwriting, since silently discarding a value the author wrote is exactly what this invariant exists to prevent.

First and only committed consumer: `normalize-value-types` (see `plans/value-type-annotation.md`).

## Decisions

- **Migrations and normalizations are separate mechanisms.** One is author-visible and meant to reach the file; the other is internal and must never leave the process. Rejected: one "rewrite pass" abstraction, which would carry a "reported / written back" flag on every entry and put desugaring one boolean away from editing a user's manifest.
- **Operations are declarative data now; the matcher grammar waits for a second entry.** The two halves justify themselves differently, and only one justifies itself yet: an operation set gives file-applicability and a derivable quick fix immediately, while a selector language rests on portability (deferred with the Rust reader) and on being a trust boundary (a module-surface property, out of scope) — and its requirements come from that same out-of-scope surface, so designing it on one core entry risks shaping it wrong. The shape is well-attested when it arrives: OpenRewrite composes recipes declaratively over closed primitives, on a formatting-preserving tree, extended by writing new *primitives* rather than new migrations. Rejected: migrations as code throughout (the Nx and Angular-schematics shape, where only the registry is data and each transform is a program), which forfeits file-applicability; and freezing the full vocabulary now, which is the mistake of sizing a grammar against a single consumer.
- **Operations are named for what they target; the model is JSON Patch's, the names are not.** `rename-key` / `set-value` / `set-tag` / `insert-item` / `remove-entry` each name their target in the verb, so the target is never inferred from which parameter happens to be present, and the quick-fix question reads off the name without knowing RFC 6902. Rejected: borrowing JSON Patch's names, which would have required documenting three departures — `move` relocates across parents where `rename-key` cannot, and refuses an occupied destination where `move` replaces it — and a lookalike wearing a standard's names invites expectations it does not meet. Also rejected: an `op` plus a separate `target` field, which opens a combination space that is mostly illegal, since renaming a value means nothing.
- **Composition is specified, not left to implementation.** One pass, match set frozen pre-migration, rules ordered within an entry, entries independent. With entries aggregated from different parties this is cross-party determinism, and it makes idempotency a driver guarantee rather than something each author must prove. Rejected: running to fixpoint with a cycle guard — more permissive, but it moves the burden onto every entry and makes one party's migration observable to another's.
- **The phase runs before desugaring, so a migration only ever matches author-written nodes.** Synthetic import manifests have no YAML document and share `variables` / `secrets` by reference with the module doc, so matching inside one would have no edit target, would record a path the file never had, and would apply twice. Rejected: keeping the later position and forbidding matches under synthetics — a runtime guard the design would then depend on, which is precisely what placing the phase correctly makes unnecessary.
- **One phase, in the loader; no post-resolution phase yet.** It would be structurally Node-only, since the Rust side has no analyze pass, and cannot be made safe by limiting such entries to analysis-only meaning — the module migrations that motivate it rename consumers' fields, which is a runtime-meaning change by definition. This reverses an earlier decision making phase a per-entry field: that field existed to serve module migrations, and the loader's desugared imports map may serve them instead. Rejected: adding the phase speculatively, when the only committed entry is pre-resolution.
- **Path provenance is in the driver's contract.** `resolveRange` resolves diagnostics against a position index built from the raw file and falls back to a parent's key or value range, so a key rename without provenance silently downgrades every downstream squiggle and lets a fix write across a parent's span. Rejected: forbidding fixes on any migrated subtree — cheap, but it concedes editor quality on exactly the manifests that need help, and leaves `telo migrate` without an edit target anyway.
- **The Rust reader and the normative spec wait for a second entry.** Deferring is safe because the committed entry's effect is not Rust-observable, which is stated rather than assumed. Rejected: freezing a cross-kernel spec and a second implementation on the evidence of one migration.
- **The split is scope and provenance, not code versus data.** Core may match any node; a module may match only its own kinds' fields. Rejected: two entry types, now that both are data — what differs is fields, not shape.
- **`DiagnosticFix` is used where it fits and not stretched where it does not.** It promises a repair applicable without review, so a key rename is honestly *no* fix rather than a corrupt one, and the entry declares which it is so a missing quick fix is stated, never silent. Rejected: extending the fix primitive with edit targets and indentation-aware rendering — a larger change to a shared type, to serve a job `telo migrate` does better through the YAML document.
- **File application reuses the existing document editing.** `manifest-imports.ts` already does comment-preserving `Document.setIn` writes. Rejected: a migration-private YAML writer, which would drift from the one `install` / `upgrade` / `publish` use.
- **Applying migrations is a composable operation, not a command.** `telo migrate` is its reference application over everything pending; `telo upgrade` composes it over just the modules it moved, so a bump repairs what it broke without dragging unrelated rewrites into the diff — and keeping it an operation is what stops the VS Code lens and the CLI diverging again. Rejected: upgrade printing "now run `telo migrate`", which asks the user to repair damage the tool just caused.
- **Rewrite always, report locally.** A published artifact must keep loading, and its author is the only person who can fix it. A field rather than a convention, so the next migration cannot get it wrong.
- **A migration that cannot rewrite leaves the node alone.** Never guess, never drop. The malformed value then fails the ordinary validator with an accurate message rather than being repaired into something the author did not write.

## Example after the change

The committed consumer is one file in the analyzer's migration directory, alongside whatever else has accumulated there. One entry is one deprecation story and may carry several rules — the value-type unification changed three spellings but tells the author one thing. The `patch` blocks are data as shown; the `match` blocks are written here as the grammar is expected to look, and are predicates in code until a second entry earns it:

```yaml
# analyzer/migrations/x-telo-type-names.yaml
id: x-telo-type-names
severity: warning
reason: >-
  The three value-type annotations were unified into one `x-telo-type`, whose
  names are alias-qualified like every other named thing in Telo.
rules:
  # The key moves, then the value is replaced. Never matched under a
  # data-bearing keyword, where `x-telo-stream` would be part of a value being
  # matched or filled rather than an annotation.
  - match: { key: x-telo-stream, value: true, notUnder: [const, default, enum, examples] }
    patch:
      - { op: rename-key, to: x-telo-type }
      - { op: set-value, value: Telo.Stream }
  - match: { key: x-telo-binary, value: true, notUnder: [const, default, enum, examples] }
    patch:
      - { op: rename-key, to: x-telo-type }
      - { op: set-value, value: Telo.Bytes }
  # A lone `set-value`, so this rule — and only this one — yields a quick fix.
  # Matched against the KNOWN brands, so an unrecognized bare name is left
  # alone for `X_TELO_TYPE_UNKNOWN` to report rather than silently qualified.
  - match: { key: x-telo-type, valueOneOf: [TcpPort, UdpPort] }
    patch:
      - { op: set-value, qualify: "Telo." }
```

A module's migration is the identical shape in a different place — a `migrations:` block on its own `Telo.Library` doc, travelling in its artifact, with the driver collecting from both sources and caring about neither. What differs is only how wide a rule's `match` may reach: anywhere for an entry in this directory, fields of its own kinds for one shipped by a module.

Three things fall out of the entry rather than being decided per site. The first two rules contain a `rename-key`, so no quick fix is derivable and the driver says so; the third is a lone `set-value`, so it carries one — read off the verb, not asserted by the author. The `notUnder` guard restates a distinction the kernel's own annotation strip already draws, and is the kind of requirement that should shape a selector grammar rather than be discovered after one is frozen. And nothing here says when to walk, how to report, or who may be blamed — those are the framework's, uniform across every entry.

A key rename therefore carries no quick fix, and says so rather than offering one that would corrupt the file:

```
warning  x-telo-type-names  modules/mine/telo.yaml:47:9
  `x-telo-stream: true` is now written `x-telo-type: Telo.Stream`.
  The three value-type annotations were unified into one `x-telo-type`, whose
  names are alias-qualified like every other named thing in Telo.
  no quick fix (renames a key) — run `telo migrate`
```

The squiggle lands on the author's own line because the driver recorded which path it rewrote, so later diagnostics about that node resolve back through the legacy path rather than a path the file never had. `telo migrate` applies every pending migration across the entry's own modules, through the same comment-preserving document editing that rewrites the imports map, and leaves imported ones alone:

```
$ telo migrate
x-telo-type-names  modules/mine/telo.yaml  3 rewrites
3 rewrites in 1 file. Imported modules were not touched.
```

Until the author runs it, nothing breaks: the load-time phase has already rewritten the manifest in memory, so the old spelling and the new one behave the same. Adding the next migration is one entry — and when the module surface lands, its entries join the same listing, since the driver collects by shape and not by who declared them.
