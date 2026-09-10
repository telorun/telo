---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

Review fixes on the template-body change set. Two were breaking, two made the
suite that guards all of this weaker than it reads.

**The kernel reads the legacy dispatch spellings again.** Refusing a bare string,
a `{ kind, name }` dispatch and a CEL-named entry broke every app pinning a
version that carries them — `crud@0.14.2` ships `mount: api` and four
`!cel "self.name + '-…'"` entry names — and `telo check` was silent, because a
dependency's body is entry-scoped. So the failure was a boot-time `ERR_*` naming
a kind the consumer never wrote: the check/run disagreement this work exists to
remove, reintroduced at the dependency boundary and blaming an author for a
spelling that was valid when they published. Migrations cannot finish the job
(`mount: api` is a `set-tag`, the object form needs a patch verb that does not
exist, and a computed entry name has no literal a rewrite could compute), so
compatibility is the answer and the push is
`DEPRECATED_TEMPLATE_DISPATCH_FORM` / `DEPRECATED_TEMPLATE_ENTRY_NAME` —
warnings, in the entry module.

**The `Telo.Definition` dispatch slots are constrained again.** They had been
left as `{title, description}` on the reasoning that `validate-template-body`
resolves them; that pass is entry-scoped, so a dependency's definition had
nothing checking the slot where AJV used to. An `anyOf` of the three real shapes
restores the floor.

**`BASE_WITH_TEMPLATE_BODY` used one predicate, not two.** The analyzer scanned
keys with a length test while the kernel branched on
`hasOwnControllerOrTemplate`, so an empty `resources: []` checked clean and threw
at boot — a brand-new guard shipping with the gap it was written to close. The
analyzer now calls the shared predicate and uses the scan only to name the key.

**`Assert.Manifest` gains `expect.runs`, and `runFails` is bounded.** `expect: {}`
runs nothing, so the four "checks clean AND runs clean" fixtures asserted only
half of what their headers claimed and the two kernel-only fixes had no runtime
coverage at all. `runs: true` asserts exit 0; both run paths race a 30s timer,
`cancel()` in a `finally`, and report a timeout as an ordinary assertion failure
— a fixture that regresses into running forever is now a failing test rather than
a hung suite.

**The inherited-required hint keys on structured data.** `SchemaIssue` carries
`keyword` and `missingProperty`, so the hint no longer substring-matches the
validator's prose — which would have broken silently when the wording changed and
mis-fired on any other issue quoting the same field name.

**`x-telo-context-from-ref-kind`'s dispatch reading is gated to `Telo.Definition`.**
`resources:` means "entry list" only there; the annotation is generic vocabulary,
so a third-party kind with its own `resources:` array would have had a slot
silently resolved against it. The IDE's declaration resolver also now falls
through per spec exactly as the type resolver does, instead of aborting on a
malformed one and returning a field the target does not declare.

**`validate-provider-coherence` reads the inherited capability**, so an `extends`
child that inherits `Telo.Provider` and declares `provide:` is no longer reported
as `PROVIDE_ON_NON_PROVIDER (found '<unset>')`.

**One suggestion helper** (`nearest-name.ts`), replacing two byte-identical copies
that differed from the repo's existing ones in both threshold and tie handling.
A tie now returns undefined everywhere: these suggestions are emitted as an
applicable `DiagnosticFix`, and an arbitrary pick one click from being applied is
worse than none.
