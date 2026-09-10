---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Five shapes passed `telo check` with a clean exit and then failed at run — four of
them on the very thing the checker was silent about. The common factor was not five
missing checks: it was that each of those rules lived in a controller with no analyzer
twin, and nothing anywhere asserted the two agree.

**A template body is now written like every other manifest and checked like one.**
`validate-template-body.ts` is the one reader of a body's reference surface, replacing
`validate-template-dispatch.ts` and the target half of `validate-provider-coherence.ts`.
Between them those covered `provide:` and `mount:` for the object form, `!ref` for all
four slots but only when every sibling name was literal, and `invoke:` / `run:` not at
all — so a typo'd `invoke:` target was a runtime miss nothing reported. Every entry is
named by a LITERAL (`TEMPLATE_ENTRY_NAME_DYNAMIC`), every dispatch slot is a `!ref` to
one (`TEMPLATE_DISPATCH_UNKNOWN`), and a reference slot
INSIDE an entry follows the rule every other slot follows — `!ref` or an inline
declaration, naming a sibling or a resource of the declaring module
(`INVALID_REFERENCE_FORM`, `TEMPLATE_REF_UNKNOWN`).

**The `{ kind, name }` object form and the CEL-computed entry name are DEPRECATED,
not removed.** They are one feature — a `!ref` is looked up verbatim, so only the object
form could ever reach a CEL-named sibling — and neither buys anything now that each
template instance owns its children in a child context of its own. What they cost is
decidability: one dynamic sibling switches the target check off for the whole
definition, which the warning says. But the KERNEL reads both forever, because published
artifacts carry them (`crud@0.14.2` ships `mount: api` and four
`!cel "self.name + '-…'"` entry names) and the runtime must read artifacts published
years ago. `DEPRECATED_TEMPLATE_DISPATCH_FORM` / `DEPRECATED_TEMPLATE_ENTRY_NAME`,
warnings, entry-scoped — so a dependency's spelling is never reported to a consumer who
cannot change it.

**`base:` beside a body is refused** (`BASE_WITH_TEMPLATE_BODY`,
`ERR_BASE_WITH_TEMPLATE_BODY`). `resources:` selects the template path, which never
reads `base:`, so the kind silently became an empty template that dispatched nothing and
published nothing — surfacing in the CONSUMER's resource as `Got: {}`, with nothing
connecting it back to the mapping that produced it.

**A base-form child's own fields are compile-eval without annotation.** They are
construction inputs no controller sees, read once by `base:` at `create()` — the
`Telo.Provider` posture, for the same reason. Saying so is what makes them CHECKED: the
`CEL_IN_NON_EVAL_FIELD` gate read the DECLARED capability, which an `extends` child never
writes, so the rule was off for every inheritance kind and their expressions were neither
flagged nor typed. A `!cel "variables.whoo"` there passed `telo check` and failed at boot.

**A library's export list is resolved where it is written** (`EXPORT_KIND_UNKNOWN`,
`EXPORT_RESOURCE_UNKNOWN`). An entry naming nothing was read as a gate value and failed
in whichever consumer first used it, so the author who could fix it saw green and a
stranger saw red on a file with nothing wrong in it. A bare name that is an IMPORTED kind
gets its own message and its own fix: it is the natural first attempt at a re-export, and
a clean check read as confirmation that it worked.

**A template child is stamped with its defining module.** Phase-5 injection resolves a
resource's ref-slot field map through `metadata.module`; a child registered without one
was resolved against the ROOT application's aliases, so a library's template body worked
or failed depending on which aliases its consumer happened to import — and when it
failed, injection was skipped silently and `http-client` explained the residue as a rule
about scopes, sending the author to a remedy for a problem they did not have. That
raw-manifest fallback is gone: the request resolves its client through `ctx.resolveRef`
like every other slot.

**The kernel registers `Self` on the root context.** The analyzer registers it for a root
module and the import controller for every library, so a root Application instantiating
its own kind as `kind: Self.<Kind>` checked clean and failed at boot with "no module
imported with alias 'Self'". Found by the agreement suite below, which is the point of
having one.

**`Assert.Manifest` gains `expect.runFails`**, and `tests/check-run-agreement.yaml` is
the suite built on it: each defect is pinned twice — at the library where `telo check`
now reports it, and at a consumer whose entry-scoped analysis is silent by design, where
the kernel's own guard is the only thing left. A guard that gains a kernel half and no
static half fails the first assertion; one that gains a static half and no kernel half
fails the second. Repaired twins are asserted too, or a suite passes by refusing
everything.
