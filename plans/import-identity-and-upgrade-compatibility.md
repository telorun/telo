# Import identity failures and upgrade compatibility

Two defects on the path an author walks when they add or upgrade an import in
the telo editor. They are independent but share the same subject — what the
tooling knows about an imported module — so they ship as one change.

## Problem

**An import whose identity never resolved is reported as somebody else's
defect.** When a dependency is fetched but cannot be established as a usable
library, the analyzer invents a module name from the raw source string, the
alias registers under that invented name, and every consumer of the alias then
fails in its own vocabulary — "this dependency's kind has no schema", "unknown
kind", a reference-kind mismatch. The user is told a published module is broken
when the real fact is that *this import didn't resolve*. Handling is also
inconsistent by cause: an unreachable import produces a clean per-import error,
an import that resolves to an application aborts the whole graph load, and an
import that resolves to a nameless library — or points back at the entry
application — passes silently into the invented-name path.

**The editor walks authors into upgrades that cannot run.** `telo upgrade`
reads each candidate version's declared telo requirement and picks the newest
one this runtime can host, reporting what it held back. The editor applies
whatever version is newest, and the author discovers the incompatibility
afterwards, as a load error. The editor's Imports panel and the VS Code upgrade
hints each carry their own copy of the "which version to move to" rule, so a fix
in one leaves the other wrong.

## Solution

**One shape for every unusable import.** Manifest loading stops distinguishing
*how* an import is broken. Unreachable, malformed, resolves to an application,
resolves to something that is not a library, resolves to a library with no
usable name — each records a per-import failure, registers no dependency edge,
and continues loading the rest of the graph. The check runs for every import
declaration rather than once per distinct target, which is what closes the
silent case where an import points back at a module already visited. Hosts
already route these failures to the offending import's line and hold back the
analysis cascade for that file, so the CLI, VS Code and the editor pick the new
cases up with no host-side work. At runtime the failure stays fatal — a manifest
whose import cannot be identified must not start — and it now fails with the
message that names the import.

**No guessing about identity.** The invented-name fallback is removed outright.
An import whose identity was never established registers no alias, so every
downstream message degrades to "cannot resolve alias" — accurate, and pointing
at the import the user must fix. Hand-written manifest sets used in tests state
their resolved identity explicitly.

**Compatibility before an upgrade is offered.** The rule that reads a module's
declared runtime requirement and turns a candidate version's manifest into a
verdict moves into the analyzer, where the requirement grammar already has its
single reader; the CLI's upgrade command is refactored onto it so the two halves
cannot drift. Shared IDE support gains the selection rule — walk candidates
newest-first, stop at the first one this telo can host, and report what was held
back and why. The editor's Imports panel is consolidated onto that shared rule,
so the badge, the per-import dropdown, the add-import flow and the VS Code hints
all answer "which version" the same way.

Both hosts read candidate manifests from the public manifest cache, and both
report no host runtime, so only the telo axis is checked in an IDE — the IDE is
not the machine that will run the manifest, and a host requirement still
surfaces as a load error when the manifest is actually run.

Files that matter: manifest loading and the analyzer's alias registration in
`analyzer/nodejs/src/`, the requirement reader in the same package, the shared
upgrade rule in `packages/ide-support/src/import-upgrades/`, the Imports panel
and background import reconciliation in `apps/telo-editor/src/`.

## Decisions

- **Every unusable import is a per-import failure, never an aborted load.**
  Rejected: keeping the abort for the application-target case — one bad import
  should not blank the diagnostics for an otherwise valid file.
- **The failure stays fatal at run time.** It travels on the same channel the
  runtime already refuses to start on, so no separate non-fatal path exists that
  could let an unidentifiable import through.
- **Cause-specific wording.** "Could not be fetched", "is not a valid module
  reference" and "resolved, but is not a usable library" call for different
  actions, so they stay three messages rather than one.
- **No name guessing at all**, not even for local folder imports where the guess
  usually holds. A guess that is right most of the time is exactly what produced
  an assertion about a dependency that was never checked.
- **No blanket suppression for importers.** A file importing a broken dependency
  gets its own failure reported and its cascade held back through that import;
  suppressing everything in any file that imports a broken one would hide real
  mistakes in the importing file.
- **A failed background import load surfaces twice**: as an unresolved entry in
  the Imports panel carrying the failure message, and — from the analysis pass —
  on the import's own line. It never blocks the workspace from opening.
- **Editor-side compatibility, not hub-side.** Rejected: storing the requirement
  per version on the hub. It needs a schema change and a re-ingest pass, and puts
  a second reader of the requirement grammar outside the analyzer, for a cost the
  newest-first short-circuit already keeps at roughly one fetch per import.
- **Only a version that positively declares a newer telo is held back.** A
  candidate that cannot be read or reached is not treated as incompatible — an
  unreachable cache must never silently freeze an author's imports.
- **Verdicts are cached per module and version for the session.** A published
  version's declaration is immutable, and the check would otherwise refetch on
  every re-render.
- **Incompatible versions are listed and marked, not hidden.** The dropdown is a
  deliberate pick, and an author may knowingly select a version for a runtime
  they are about to have. When *no* listed version is usable, the UI says so and
  points at updating telo instead of rendering a list of dead options.
- **The upgrade affordance reports what it held back.** Silently reporting "up
  to date" while newer versions exist turns a pin into an invisible ceiling.
- **One upgrade rule across all hosts.** The editor panel is consolidated onto
  the shared implementation rather than calling the new check from two places —
  two implementations of the same rule is what let them diverge.

## What the author sees afterwards

Adding an import that resolves to an application, or to a module that is not a
library, marks that import's line: *"import 'Api' → '…' resolved, but is not a
usable library"* — and the resources that use the alias report *"cannot resolve
alias 'Api'"* rather than claiming a published dependency is malformed.

Upgrading with a newer-but-incompatible version published shows the import
moving to the newest version that runs on the current telo, with a note naming
the version held back and the requirement it declares. Opening the version
dropdown lists every published version, with the incompatible ones marked; if
none can run, the dropdown says so and points at updating telo instead.
