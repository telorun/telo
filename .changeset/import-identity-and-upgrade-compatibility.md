---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/cli": minor
---

An unusable import is reported as itself, and an upgrade only offers a version this telo can run.

**One shape for every unusable import.** Loading no longer distinguishes *how* an
import is broken. Unreachable, malformed, resolving to an application, resolving
to something that is not a library, resolving to a library that names no module —
each records a failure against that import, registers no dependency edge, and
lets the rest of the graph load. The check now runs per import declaration rather
than once per distinct target, which closes the case where an import pointing at a
module something else already reached (the entry application above all) skipped it
entirely. An application target used to abort the whole load; it is now a
diagnostic on its own line, and still fatal at run time because the runtime
refuses to start on any of these.

Three codes, because three different people fix them: `INVALID_IMPORT_SOURCE`
(not a module reference), `IMPORT_UNRESOLVED` (well-formed but not obtainable) and
the new `INVALID_IMPORT_TARGET` (obtained, but not importable).

**No guessing about module identity.** The analyzer used to derive a module name
from an import's source string whenever the loader had stamped none. For a pinned
ref that produced a canonical kind no registry can hold —
`http-dispatch@0.11.1#sha256-….Outcomes` — and every consumer of the alias then
failed in its own vocabulary, reporting a *dependency* as schemaless when the real
fact was that the import never resolved. The fallback is gone: an import with no
resolved identity registers no alias, and uses of it say `cannot resolve alias
'<X>'`, which names the import the author can fix.

**Upgrade affordances filter by `requires.telo`.** `manifestCompatibility` moves
the verdict (`yes` / `too-new` / `unreadable` / `unknown`) into the analyzer, where
the `requires:` grammar already has its single reader; `telo upgrade` now calls it
rather than carrying its own copy. `@telorun/ide-support` gains the selection rule
on top — walk candidates newest-first, stop at the first hostable one, report what
was held back and why — so the editor's Imports view and the VS Code lenses answer
"which version does this move to" identically. `buildImportUpgrades` takes an
environment (`listVersions` + `isCompatible`) instead of a bare lookup, so a host
cannot silently skip the check; one that genuinely cannot read candidate manifests
passes `uncheckedVersionCompatibility`, which says so. A version that cannot be
read or reached is never treated as incompatible, and only the telo axis is checked
in an IDE — an IDE is not the host that will run the manifest.
