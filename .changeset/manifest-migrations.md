---
"@telorun/analyzer": minor
"@telorun/templating": minor
"@telorun/ide-support": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/cli": minor
---

Manifest migrations: one registry and one driver for rewriting a legacy
spelling to the current one.

Telo rewrote a manifest between parsing it and analyzing it in six places, and
two different things were tangled there. Most are **normalizations** — sugar
folded into the internal form, never written back, correctly invisible. A
growing minority are **migrations**: an old spelling rewritten because published
artifacts carry it and cannot be edited. Each re-invented the same four things by
hand — where to walk, how to report without blaming a dependency the author
cannot fix, how an author is meant to *act* on the warning, and when the code may
be deleted. The last two were usually skipped: a deprecation warning told an
author something was wrong and offered no repair but hand editing.

Adding a migration is now one JSON file in `analyzer/migrations/`. **An entry
contains no code** — both what a rule matches and what it patches are data, so
one file is read identically by every kernel; a predicate expressed in one
language would mean one artifact is read two ways, invisibly, since a migration
that succeeds is silent. JSON rather than YAML because it is the only format all
three runtimes embed with no generation step (Rust `include_str!`, Go
`//go:embed`, TypeScript `resolveJsonModule` and nothing else).

- **The patch names what it targets**: `rename-key`, `set-value`, `set-tag`,
  `insert-item`, `remove-entry`. Every operation has a known YAML edit form,
  which is what makes a migration applicable to a *file* and what lets the driver
  **derive** whether a quick fix exists — read off the verb, never declared, so a
  missing repair is stated rather than silent. A lone `set-value` yields a
  `DiagnosticFix`; anything else says `no quick fix (removes an entry) — run
  \`telo migrate\`` instead of offering one that would corrupt the file. A
  written value must be a scalar, refused when the entry is *read*: the file
  applier re-quotes a value in the author's own style at the node's own span,
  which has no meaning for a mapping, so accepting one would hide the limitation
  until a user ran `telo migrate` and was told, permanently, to fix it by hand.
- **The matcher's containment is positive and required**: `inKind` names the
  document kinds a rule may touch and `under` the region within them it may
  reach; nothing outside is reachable. `under` is **anchored at the document
  root** — it names top-level keys — which is what makes that claim true rather
  than decorative: a `Telo.Definition`'s `resources:` template body carries other
  kinds' configuration, so a rule matching "any path segment spelled `schema`"
  would reach the very user JSON blob the positive form exists to keep out.
  Walking everything and subtracting cannot be made sound — the set to subtract
  is unbounded, since any kind whose config carries a user JSON blob can hold
  something shaped like the node a rule looks for — and it cannot express the
  guarantee the module surface is promised to carry. Both halves are closed
  vocabularies at every level; an unknown token is refused, `$comment` aside.
  Both gates bound the *walk* rather than filter its output, so a document no
  rule targets is never walked and a region no rule names is never descended
  into — this runs on the kernel's boot path for every file in the graph.
- **The phase runs in the loader**, after parse and before both the CEL
  precompile and import desugaring, so a rule only ever matches author-written
  nodes — a synthetic import manifest has no YAML document to edit, would record
  a path the file never had, and shares `variables` / `secrets` by reference with
  the module doc.
- **Composition is the driver's guarantee**: one pass with the match set frozen
  against the pre-migration tree, rules ordered within an entry, entries
  independent. Idempotency follows from that rather than from every author
  getting it right. A patch that cannot apply in full applies not at all. A
  frozen match reaches through a sequence by index, and an index is not an
  identity, so a match under an array a sibling patch resized is refused rather
  than rewriting the element that patch produced.
- **Rewrite always, report locally.** Every file in the graph is rewritten, so a
  module published years ago keeps loading; only the entry module's own files
  report, because a published dependency is not the consumer's to fix.
  `LoadedGraph` gains `migrationDiagnostics`, `LoadedFile` gains `migrations`.
- **Path provenance is in the driver's contract.** Each rewrite records the path
  it matched beside the migrated one, and every downstream diagnostic is mapped
  back through it before its position is resolved — without which a key rename
  would silently downgrade every squiggle on that node to a parent squiggle, and
  let a fix among them write across a parent's span. The general index is by
  FILE, so a diagnostic that names only its file (as many do) and a rewrite in a
  document with no `metadata.name` (every `Telo.Import`) are both reachable;
  resource identity narrows within a file rather than being the only key.
- **A migration is reported everywhere the manifest is read.** `telo run` warns
  through the kernel logger, alongside the version-hoist warning it already
  emitted — otherwise the one command an author actually uses would be the only
  surface that rewrote their manifest silently. The SDK's `check` seam remaps
  paths like every other consumer, so a module acting on `path` and an editor
  rendering a squiggle never disagree about what a manifest says.
- **`LoadOptions.migrate`** is a new, opt-in third cache axis beside `compile`
  and `desugarImports`. Every resolved consumer passes it; a round-trip view must
  not, since the editor writes its manifest/YAML pair back on save.
  `ctx.loadModule`'s `LoadOptions` (SDK) gains the same flag.
- **`telo migrate <paths..>`** applies pending migrations to a file, through
  byte-level splices — comments, indentation, block scalars and quote style are
  preserved, exactly as `telo upgrade`'s rewrite already is. Imported modules are
  left alone. A location whose YAML cannot carry the edit is reported rather than
  silently skipped, since the diagnostic that sent the author here says to run
  this command. Removing a mapping entry that *opens* a sequence item
  (`- type: string`, the shape a legacy `anyOf` branch takes) splices out to the
  following key instead of deleting the line, which would take the `- ` with it.

- **The scalar re-quoting rule and the byte-splice loop are one primitive**
  (`yaml-source-edit.ts` in `@telorun/analyzer`, browser-safe), read by the
  migration applier, `@telorun/ide-support`'s quick fix and `telo upgrade`'s pin
  rewrite. Three surfaces now write repairs into the same files; two copies of a
  subtle quoting rule would eventually quote one value two ways and nothing would
  catch it. `@telorun/ide-support` re-exports `renderFixReplacement`,
  `quoteStyleOf` and `isPlainSafe` unchanged.

**Breaking:** `normalizeRefSlots` is removed from `@telorun/templating`. It
dropped the legacy scalar `type:` at an `x-telo-ref` slot at every
schema-compile site, which the shipped `ref-slot-scalar-type` entry now does once
at load. Keeping both would have left one rewrite with two traversals that match
different node sets, and it falsified the design's own safety property — a
consumer who forgot `migrate` behaved identically apart from the missing warning,
so the entry could not prove the mechanism it demonstrates. Nothing outside this
repo is known to call it; a manifest still carrying that spelling is repaired by
the migration on every load, and `telo migrate` fixes the file.
