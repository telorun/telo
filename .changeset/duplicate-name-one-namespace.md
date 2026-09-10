---
"@telorun/analyzer": minor
---

**An application named after one of its own imports passed `telo check` and died at
boot.** `metadata.name: Scheduler` beside `Scheduler: oci://…/scheduler` declares
`Scheduler` twice, and the kernel refused it with `ERR_DUPLICATE_RESOURCE` naming only
the string — nothing about the two lines looks like one name written twice, so the
error read as a runtime mystery rather than as a manifest defect.

**The duplicate-name check modelled a narrower namespace than the kernel's.**
`registerManifest` keys on `metadata.name` alone, per module context, for EVERY kind, so
an import alias, a kind definition and an ordinary resource are one namespace. The check
excluded `Telo.Import` outright — on the stated grounds that an alias "lives in a
separate namespace from resources", which is false — and let `Telo.Definition` /
`Telo.Abstract` fall through the ref-validation skip set, which answers a different
question. Three collisions therefore checked clean and failed at boot: an alias against
the module's own name, an alias against a resource, and a kind definition against a
resource. All three are now `DUPLICATE_RESOURCE_NAME`, whose message names what each
side IS — an alias is not a resource, and a module's own name is not a declaration
inside it, so calling all three "resource name" described two of them wrongly.

**Grouped per declaring module, which is what makes including imports sound.** A
library's own `Telo.Import` / `Telo.Definition` docs are forwarded into a consumer's flat
set, so an app and a library it imports both aliasing `Console` is ordinary rather than a
collision; a scope whose module doc is absent is a dependency's, left to that
dependency's own `telo check`. A module doc carries no `metadata.module` and is its own
scope, which is what puts an application's name beside its imports.

**Kept apart from the by-name resolution lookup it shared a map with.** That map holds
resolution TARGETS alone — an alias and a kind definition are neither — so the two
questions disagree about membership by design, and merging them re-keys every bare-name
reference into an `UNRESOLVED_REFERENCE`. Two imports sharing an alias stays exactly one
`DUPLICATE_IMPORT_ALIAS`, since that code says what to do about it.

Pinned in `tests/check-run-agreement.yaml` in both halves: statically where the analyzer
now reports it, and at a consumer of a library carrying the collision, whose entry-scoped
analysis is silent by design and where `ERR_DUPLICATE_RESOURCE` is the only thing left.
