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

- The capability list exists in **four** copies that disagree. `packages/ide-support` is missing
  `Telo.Sink`. Worse, two are semantically inverted: the kernel lists `Telo.Executable` *so that it
  is rejected* (`manifest-schemas.ts` uses `not: { enum: … }`), while `analyzer/rust/src/builtins.rs`
  applies the same list with the opposite polarity — so Rust accepts a capability Node rejects, and
  rejects `Telo.Template`, which the Node builtins declare on five entries.
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
the barrel; its three import sites are untouched. Schemas move verbatim — the `x-telo-context`,
`x-telo-ref` and `x-telo-step-context` payloads drive CEL typing and ref resolution and are not
decoration. Each entry gains an authored `description`, which is new content and is what the hub
embeds as search text.

**A new CLI verb family, `telo builtin`,** with subcommands `kinds`, `manifest`, `types` and `tags`,
in text and JSON, through the `Output` seam as bare documents. `manifest` renders the entries as YAML
docs — the exact field shapes an agent must produce. `types` is the `telo cel types` that
`sdk/value-types/README.md` has been promising and that was never built. `tags` reads the existing
engine registry, which gains a `description` member alongside its `name` / `language` / `producedType`.

**The duplicate copies collapse onto the entries.** The kernel's capability enum and its capability
`oneOf` are derived from them; `packages/ide-support/src/completions/valid-capabilities.ts` is deleted
and both its exports sourced from them; `analyzer/rust/src/builtins.rs` reads the same bytes, keeping
only `SUPPORTED_CAPABILITIES` Rust-local as the host-specific table — the exact analogue of
`bindings()` in `sdk/rust/src/value_type.rs`. The two half-schemas for `Telo.Definition` /
`Telo.Abstract` are unified into one.

**The hub indexes it like a module, without pretending it is one.** A reserved `modules` row for
`Telo` carries `transport: builtin`, marking it as neither tracked nor fetchable. A dedicated ingest
sequence calls `telo builtin --json`, keys on the telo release version, writes a real
`module_versions` row and reuses the existing kind-insert and embed steps — no version enumeration,
no digest probe, no artifact. History accumulates one version per hub CLI upgrade. `extends_ref` is
backfilled to the reserved ref, retiring the empty-ref convention that `/implementations` and the hub
README currently document.

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
- **The version is the telo release version.** An agent already knows which telo it runs; an
  independently-bumped vocabulary version would force a mapping nothing provides. Cost is consecutive
  rows with byte-identical vocabulary, which is cheap — embedding runs only for `latest_version`.
- **Same version with a moved content hash is a hard error**, mirroring the invariant
  `cli/nodejs/src/bundle/payload-drift.ts` already enforces for modules.
- **"Is a capability" and "is declarable as a capability" are separate fields.** Modelling them as one
  would encode either Node's or Rust's current polarity as the shared truth and silently flip the other
  runtime.
- **A reserved `modules` row, not a separate table.** `resource_kinds` needs the foreign key and every
  search surface joins `modules`; a parallel table would require a UNION in each. `Telo` genuinely is
  the module that owns the `Telo.*` kinds — it is simply not a published one.
- **`extends_ref` is backfilled and the empty-ref convention retired.** Without it builtins become
  searchable but still unjoinable, which is half the payoff.
- **Scope covers kinds, capabilities, value types and tags.** They are subcommands of one verb reading
  three data sets that all already want to be data; omitting any leaves a conspicuous hole. Engine
  `compile` / `analyze` stay code — only the roster is data.
- **This supersedes `analyzer/nodejs/plans/builtin-kinds-encapsulation.md`**, whose `throwsAllowed` and
  `pureType` become entry fields here. Two of its three parts are unimplemented; the third landed by
  other means.

## After the change

```
telo builtin kinds              # the roster: name, capability, description
telo builtin manifest           # rendered docs — exact field shapes
telo builtin types              # the x-telo-type vocabulary
telo builtin tags               # !cel, !ref, !include-text, !include-bytes, !literal, !sql
telo builtin kinds --json       # same, as a bare document
```

Through the hub, `search_resources("write log records somewhere")` returns `Telo.ConsoleSink` and
`Telo.FileSink` beside `Otlp.Sink`, and the `Otlp.Sink` hit's `extends` resolves to a real ref instead
of an empty string — so `/implementations` can enumerate every implementation of a built-in contract
across module boundaries.

Also required, and part of the work: authored descriptions for every entry (hub search text), a
matching update to the authoring agent's system prompt in `apps/authoring-agent/chat/telo.yaml`, a
CLAUDE.md sync, removal of the stale `telo cel types` reference, changesets for the published packages
and a changie fragment for the hub app.
