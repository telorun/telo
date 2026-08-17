# Plan — Expose the built-in vocabulary as data

## Problem

Everything in Telo that needs no import — the `Telo.*` kinds, the capability abstracts, the
document schemas for `Telo.Application` / `Telo.Library` / `Telo.Definition`, the `x-telo-type`
value types and the templating tags — is unaddressable. `KERNEL_BUILTINS`
(`analyzer/nodejs/src/builtins.ts`) is a TS array literal with no manifest source and no ref, so
nothing can print it, fetch it, or search it. An AI agent authoring a manifest learns this surface
only from prose in a system prompt, and a stale primer produces manifests against a vocabulary that
no longer exists.

Unaddressability has already caused drift, because a vocabulary nothing can read is a vocabulary
every consumer re-declares:

- The capability list exists in **four** copies that disagree, and two of them disagree about
  something bigger than membership. `packages/ide-support` is missing `Telo.Sink`. The kernel's
  `KNOWN_CAPABILITIES` exists only to *subtract* names from an open fallback branch
  (`not: { enum: … }` + `unevaluatedProperties`), so on Node an unrecognized capability is
  **accepted** as a third-party extension; `analyzer/rust/src/builtins.rs` **closes** the set, so any
  name off its seven-entry list is a hard manifest failure. `Telo.Template` — declared by five of the
  Node builtins — and every third-party capability therefore load on one runtime and fail on the
  other.
- `Telo.Definition` and `Telo.Abstract` are validated by **two complementary half-schemas**: the
  analyzer knows the template-body fields, the kernel knows `capability` / `extends` / `controllers` /
  `throws`. A definition with a misspelled `controllrs:` passes the analyzer; a bad CEL context in
  `invoke:` passes the kernel.
- The Rust analyzer carries builtin *names only*, with a header comment pointing back at the Node file.
- The hub cannot index them, so `extends: Telo.LogSink` is stored with an empty `extends_ref`,
  structurally unjoinable to anything.

## Solution

**The vocabulary becomes data.** One JSON file per entry under `analyzer/builtins/`, copied into
`analyzer/nodejs/src/builtins/entries/` by `scripts/copy-builtin-entries.mjs` with a generated barrel,
and read by Rust through an `include_str!` list. This is the arrangement `sdk/value-types/` and
`analyzer/migrations/` already use, for the reason their READMEs give: JSON is the only format all
three target runtimes embed with no generation step, and a registry written as one language's code is
a second registry that drifts silently. `analyzer/nodejs/src/builtins.ts` becomes a thin builder over
the barrel; its three import sites are untouched. The `x-telo-context`, `x-telo-ref` and
`x-telo-step-context` payloads drive CEL typing and ref resolution and move unchanged.

**An entry's schema keeps its fragment references; expansion stays in the builder.** A slot writes
`$ref: telo://manifest#/$defs/KindSchema`, not the expanded body, because the reference states the one
fact the expansion erases — *this slot holds a KindSchema* — which is what the IDE reads off the
`x-telo-fragment` stamp and what a future Rust schema validator would resolve. A reference can always
be expanded; an expanded copy cannot be un-merged back into an identity. Two cleanups fall out of
writing the entries as data:

- **The `LOG_SINK_COMMON_PROPERTIES` spread goes.** `Telo.ConsoleSink` / `Telo.FileSink` already
  `extends: Telo.LogSink`, and `effectiveAuthorSchema` merges parent into child along `extends`, so
  spreading the parent's properties into each child is redundant today and would be duplication-in-data
  tomorrow. Children declare only their own fields.
- **What two entries genuinely share becomes a named fragment.** `PROVENANCE_METADATA`,
  `LAYER_INDEX_SCHEMA`, `LIBRARY_CANDIDATES_SCHEMA` and `LOGGING_SCOPE_PROPERTIES` are all shared by
  `Telo.Application` and `Telo.Library` — which is exactly what the analyzer's fragment set is for, and
  the move `InvokeStep` already made. The fragment set itself stays code in this change; the `$ref`
  form is what keeps moving it to data available later.

**The capability roster is closed, and membership is separate from declarability.** A capability names
a lifecycle the *kernel implements and dispatches*, so a third party cannot add one without changing a
kernel — Node's open fallback branch was accepting manifests that could never run, deferring a schema
error into an unexplained runtime one. Every `capability:` in this repo is already one of the seven
`Telo.*` names, so closing costs nothing in-tree. Each entry carries two independent booleans:
`capability` (this name is a lifecycle role — the seven plus `Telo.Template`) and `declarable`
(may appear in an author's `capability:` field). `Telo.Template` is a roster member reserved for the
five document kinds; `Telo.Executable` is not a capability at all and must not become one by sitting
in the same file. Node drops the `not: { enum }` branch and states the roster positively; Rust keeps
its closed check and gains `Sink` and `Template`. Both then reject the same set for the same reason.

**One `description` per entry, first sentence standing alone.** It is a description, not a search
payload: any consumer needing a one-liner takes the first sentence, the way rustdoc, godoc and JSDoc
all resolve this. Hover renders the paragraph — strictly better than today's hand-maintained six-word
`CAPABILITY_DOCS` lines. The hub **composes its own embedding input** from the name, capability,
categories and description it already holds, rather than telling authors to write the field in a
special register. That inversion is what makes the field honest, and it removes the current asymmetry
where a good description is penalised for naming its own kind — so **CLAUDE.md's `Manifest
descriptions — MANDATORY` section is rewritten as part of this change**, from a contract the field
carries into guidance on writing one well.

**A new CLI verb family, `telo builtin`,** with subcommands `kinds`, `manifest`, `types` and `tags`,
in text and JSON, through the `Output` seam as bare documents. `manifest` renders the entries as YAML
docs — the exact field shapes an agent must produce. `types` is the `telo cel types` that
`sdk/value-types/README.md` has been promising and that was never built. `tags` reads the existing
engine registry, which gains a `description` member alongside its `name` / `language` / `producedType`.

**The duplicate copies collapse onto the entries.** The kernel's capability enum and its capability
`oneOf` are derived from them (`throwsAllowed` becomes an entry field, replacing the hand-rolled
`forbidThrows` branches); `packages/ide-support/src/completions/valid-capabilities.ts` is deleted and
both its exports sourced from them; `analyzer/rust/src/builtins.rs` reads the same bytes, keeping only
`SUPPORTED_CAPABILITIES` Rust-local as the host-specific table — the exact analogue of `bindings()` in
`sdk/rust/src/value_type.rs`. The two half-schemas for `Telo.Definition` / `Telo.Abstract` are unified
into one.

**The hub indexes it like a module, without pretending it is one.** A reserved `modules` row with
`ref: telo://builtin` and `transport: telo` carries the vocabulary. The shape is a regular module ref
— scheme plus path, exactly like `oci://ghcr.io/telorun/console` — so no client branches on it and
`/implementations?ref=telo://builtin&kind=LogSink` is the ordinary query with a different literal. The
scheme is `telo://` because that prefix already means *owned by the runtime, never fetched*
(`telo://manifest#/$defs/…`, `telo:<module>/<Type>`, `pkg:telo/local/…`), and because it is
**unresolvable by construction**: `refGrammar()` returns `null` for it, no source claims the scheme, so
an import that names it fails at load rather than reaching the network. The registry-shaped
alternative (`telo/builtin`) is rejected — it would route to the real registry, and hub registration is
open and unauthenticated, so a reserved identity would live in a namespace anyone can publish into.
`module_publisher` gains a `telo` branch beside the `url` one, and an import whose source carries the
scheme gets a dedicated diagnostic: *`Telo.*` kinds are built in — remove this import.*

**Ingest is the module path with a different origin.** A dedicated sequence calls
`telo builtin manifest -o json` — the same verb shape the hub already uses for
`telo module manifest --json` — writes the rendered manifest to the manifest bucket at
`telo/builtin/<version>/telo.yaml` (a legal `manifestCacheKey` with `transport: telo`,
`host: builtin`), and reuses the existing kind-insert and embed steps. No version enumeration, no
digest probe, no artifact. Because the manifest lands in the cache like any other version,
`get_module_manifest` and `/module/manifest` work unmodified — which matters, since the whole point is
the search → manifest → author loop.

**Version is provenance; the content hash is identity.** `module_versions.version` is the CLI package
version (an agent already knows which telo it runs, and changesets bumps the CLI whenever the analyzer
moves), while `digest` and `integrity` are the hash of the rendered bytes. Nothing needs a repo-wide
version alignment, and the drift guard needs no new mechanism: `digest` already exists to detect one
version resolving to different bytes, which for this row is exactly the failure that must be fatal.

**Three facts distinguish the three classes of entry, and all three are already owned by something.**
"Needs no import" is a property of the *module* — `transport: telo` says it — surfaced on the hit as
`module.builtin: true`, with one line added to the MCP instructions: a builtin module is written with
**no `imports:` entry**, and its kinds are referenced as `Telo.<Kind>` with the fixed prefix, never an
alias. Contract vs instantiable is the existing `abstract` column. Document kind vs resource kind is
`capability == 'Telo.Template'`. Ingest writes one computed `class` column (`document | contract |
kind`) from those, rather than repeating the derivation in five queries. The document kinds **are**
indexed: `Telo.Application`'s exact field shapes are the most valuable thing here for an authoring
agent, and precisely what a stale prose primer gets wrong. `extends_ref` is backfilled to the reserved
ref, retiring the empty-ref convention that `/implementations` and the hub README currently document.

Work lands in five parts, in order: extract to data; collapse the duplicates; the CLI verb; hub
ingest; docs and release. The schema unification is sequenced as its own change — it is the only item
that can stall, and the other four do not depend on it.

## Decisions

- **Data lives in `analyzer/builtins/`, not `kernel/`.** The analyzer owns the registry; the kernel
  only mirrors it into the controller registry and hardcodes a kind→controller map for the three
  entries that have controllers. Both precedents put the data at the top of the owning package.
- **One JSON file per entry.** Matches both precedents exactly, including the copy script, the
  generated barrel, the gitignored destination and the root `prepare` hook.
- **A dedicated `telo builtin` verb, not `telo module <ref>`.** Three of the four module verbs are
  meaningless against something with no artifact — `install` is nonsense and a one-element `versions`
  list is a lie. Rejected: reusing `telo module`, which would need a special case in every verb.
- **Named `builtin`, not `kernel` / `core` / `std` / `prelude`.** `kernel` would be factually wrong —
  the definitions live in the analyzer, there are two kernels, and the Rust one hosts almost none of
  these kinds. `core` and `std` do not separate this set from the standard library, and `std` already
  means the opposite thing in module refs. `prelude` is the most precise term but addresses the wrong
  audience. `builtin` names the defining property — ships with the runtime, no import, no alias — and
  is already the codebase's own word.
- **No published artifact; the CLI is the origin.** Nothing outside the hub needs a fetchable builtin
  manifest — the editor, ide-support and third-party tools all read the analyzer package. Publishing
  one would create a second copy of the vocabulary related to the binary only by a derivation that has
  to be kept honest. Accepted cost: the hub only ever sees versions its own CLI carried, so history has
  gaps across a multi-version upgrade. A version nobody deployed is a version nobody authored against.
- **"Is a capability" and "is declarable as a capability" are separate fields.** Modelling them as one
  would make `Telo.Template` either invisible to the roster or writable by an author, and would encode
  one runtime's polarity as the shared truth.
- **A reserved `modules` row, not a separate table.** `resource_kinds` needs the foreign key and every
  search surface joins `modules`; a parallel table would require a UNION in each. `Telo` genuinely is
  the module that owns the `Telo.*` kinds — it is simply not a published one.
- **`extends_ref` is backfilled and the empty-ref convention retired.** Without it builtins become
  searchable but still unjoinable, which is half the payoff. `''` today means two things — "extends
  nothing" and "extends a built-in" — separable only by inspecting `extends_kind`, and it is a foreign
  key pointing at nothing.
- **Scope covers kinds, capabilities, value types and tags.** They are subcommands of one verb reading
  three data sets that all already want to be data; omitting any leaves a conspicuous hole. Engine
  `compile` / `analyze` stay code — only the roster is data.
- **This supersedes `analyzer/nodejs/plans/builtin-kinds-encapsulation.md`**, whose `throwsAllowed` and
  `pureType` become entry fields here. Its classification half — the `Telo.Module` / `Telo.MetaKind`
  abstracts that would retire the scattered `kind === "Telo.X"` checks — is **not** carried over: it
  changes classification paths across a dozen files in both packages and depends on nothing here. In
  the data form it is two more entry files plus `extends` edges, so deferring it costs a follow-up, not
  a rewrite.

## After the change

```
telo builtin kinds              # the roster: name, capability, description
telo builtin manifest           # rendered docs — exact field shapes
telo builtin types              # the x-telo-type vocabulary
telo builtin tags               # !cel, !ref, !include-text, !include-bytes, !literal, !sql
telo builtin kinds --json       # same, as a bare document
```

Through the hub, `search_resources("write log records somewhere")` returns `Telo.ConsoleSink` and
`Telo.FileSink` beside `Otlp.Sink`, each builtin hit carrying `module: { ref: "telo://builtin",
builtin: true }` so an agent writes no import for it, and the `Otlp.Sink` hit's `extends` resolves to
`{ ref: "telo://builtin", kind: "LogSink" }` instead of an empty string — so `/implementations` can
enumerate every implementation of a built-in contract across module boundaries, and
`get_module_manifest("telo://builtin")` returns the field shapes to author against.

Also required, and part of the work: authored descriptions for every entry, the rewrite of CLAUDE.md's
`Manifest descriptions — MANDATORY` section (contract → guidance, with the hub composing its embedding
input), a matching update to the authoring agent's system prompt in `apps/authoring-agent/chat/telo.yaml`,
a CLAUDE.md sync for the vocabulary itself, removal of the stale `telo cel types` reference, changesets
for the published packages and a changie fragment for the hub app.
