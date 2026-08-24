# Pinned import upgrades

## Problem

Upgrading an import from the VS Code lens leaves it **less safe** than upgrading
it from the CLI. `buildImportUpgrades` re-points the import at a newer version
and deletes its `#sha256-…` fragment, because the pin hashes the `telo.yaml` of
the version being replaced — carrying it forward would turn the next install
into a tamper error. The lens then tells the author to run `telo upgrade` to
re-pin. Two front-ends, one operation, different YAML.

The same gap leaves an import that is *already* at the latest version but carries
no pin untouched by the editor forever, while `telo upgrade` pins it in place
(`ensurePinned`, `cli/nodejs/src/commands/upgrade.ts`).

Recomputing the hash editor-side works in VS Code — the extension already bundles
`@telorun/kernel/transports` for origin-direct diagnostics — but not in
`apps/studio`, which is a browser and can neither speak OCI nor extract a
tar. It would also put a manifest download on the upgrade path.

## Solution

The hub already downloads every tracked version's `telo.yaml` during ingest and
already serves the version list the lens is built on. It serves the pin
alongside it: one request, no transport in the editor, and no loss of coverage —
the lens only ever appears for modules the hub tracks.

The hash is **never derived from manifest text by a consumer**. `manifestHash` is
transport-specific by construction (raw response bytes for registry/HTTP, the
UTF-8 text extracted from the tar layer for OCI), and `cli/nodejs/src/registry-hash.ts`
already warns that a caller-side branch silently degrades the moment a transport
is added. The value travels from the transport that produced it, out through the
CLI verb the hub already shells, into a column, out of the route.

**CLI** — `telo module manifest --json` (`cli/nodejs/src/commands/module.ts`)
gains an `integrity` field beside `ref` / `cacheKey` / `manifest`, from the
existing `fetchManifestHash` wrapper. It is best-effort but never silent: the
manifest resolved, so failing the command over a pin would break every caller
that wants the text, and the reason goes to stderr because `--json` owns stdout
and "no transport owns this ref", an auth rejection and a network blip must not
collapse into an unexplained `null`. `telo module digest` is untouched: its value
is opaque and transport-native (for OCI, the *image manifest* digest), it exists
for change detection, and the two are different values for different jobs.

**Hub** (`apps/hub/telo.yaml`) — a migration adds a nullable
`module_versions.integrity` with three distinct states: a hash, `''` for
"asked, nothing could hash this ref", and NULL for "never asked". `SyncVersion`'s
`upsertVersion` binds it; the `ingest` gate re-ingests when the row is absent,
the digest moved, **or the stored integrity is NULL**, so versions tracked before
this change backfill themselves on their next sync pass while one that can never
be hashed settles after a single pass. Collapsing `''` into NULL would re-ingest
those forever, and an ingest is the whole `then:` branch — a second origin pull,
the R2 put, kinds and resources re-inserted, and for the latest version a vector
purge plus re-embed. `/module/versions` returns `versions: [{ version, integrity }]`,
newest-first as today.

**`@telorun/ide-support`** — `ModuleVersionLookup` returns those objects.
`buildImportUpgrades` reports two categories: imports that are **behind** (bumped
and re-pinned in one edit) and imports **at the latest version carrying no pin**
(pinned in place). `buildEdits` stops deleting pins: a scalar shorthand gets the
fragment written into its source, and an object-form `integrity:` has its value
replaced in place, preserving the shape the author wrote. That is what lets a
flow-style `{source: …, integrity: …}` entry be re-pointed at all: it was skipped
only because a stale pin had to be removed by a whole-line splice, and replacing
a value scalar is a point edit that works in any style. `ImportUpgradeSkip`
survives for the one residual case with the same shape — a flow-style pinned
entry whose target version the hub publishes no pin for, where the stale hash can
be neither replaced nor spliced out.

**Hosts** — `parseModuleVersions` in `ide-support` is the single reader for the
route's body (pure, so the host still owns the `fetch`), used by
`ide/vscode/src/ide-adapter.ts` and `apps/studio/src/hub-search.ts`;
`EditorIdeAdapter` and the editor's sidebar hooks go through the latter rather
than re-reading the route, and `apps/hub-web/src/api.ts` keeps a name-only reader
since it has no `ide-support` dependency. Four hand-rolled copies of one parse is
what let the response shape change while one of them silently kept filtering for
strings. The lens
(`ide/vscode/src/import-upgrade-lens.ts`) renders a per-entry affordance for each
category and one command that applies both; the "pin was dropped, run
`telo upgrade`" notification survives only for the residual case where the hub
reports no integrity for the target version.

Trust is unchanged. Install and run stay origin-direct and re-verify the pin
against the bytes they fetch, so a wrong hub-supplied hash fails loudly at
install and can never cause substituted content to be accepted. That argument
covers a wrong *hash*; it does not cover a value that is not a hash at all, so a
pin is shape-checked (`isCanonicalIntegrity`, `@telorun/analyzer`) before it is
spliced into the author's YAML — a stray quote or newline would corrupt a
manifest that then never reaches an install to be verified.

## Decisions

- **The hub serves the pin; the editor never computes it.** Rejected:
  recomputing via `Transport.manifestHash` in the extension — Node-only, so
  `telo-editor` could never do it, and it adds a manifest download per upgrade.
- **`/module/versions` returns objects, not strings.** Rejected: an additive
  parallel `integrity` map keyed by version — back-compatible, but it encodes the
  pairing positionally in a second structure that can disagree with the first.
- **No tolerance for an un-upgraded hub.** Clients and hub version together; an
  old client already fails against a new hub, so a shim for the reverse buys
  nothing.
- **The ingest skip is gated on `integrity IS NOT NULL`.** Self-healing on the
  next sync pass; rejected a one-off backfill job as more machinery for a
  one-time need.
- **The lens also pins an up-to-date import that carries none**, matching
  `telo upgrade`'s `ensurePinned`. The editor and CLI then agree on every case,
  which is worth the lens firing on files that are not "outdated".
- **A missing integrity is never fatal, but never silent either.** The CLI emits
  `null` with the reason on stderr (as `cacheKey` already degrades), the hub
  stores `''`, and the editor falls back to today's behaviour: bump the version,
  drop the pin, say so.
- **A pin from the network is validated before it is written.** Rejected: relying
  on install-time verification alone — it catches a wrong hash, not a value that
  breaks the YAML it lands in.
- **The rollout is ordered: CLI release → image bump → hub ingests pins.** The
  hub tracks with its base image's `telo`, so nothing it stores can carry a pin
  until a release ships the field. Rejected: mounting the workspace CLI into the
  container for the e2e — that reverses a deliberate decision (the tracker uses
  what it ships with) to make one assertion tighter.
- **`telo module digest` and `telo module versions` stay as they are.** The first
  answers a different question; the second would have to download every version
  to hash it.
- **`apps/studio`'s own upgrade UI is adapted, not re-pointed.** It does not
  go through `buildImportUpgrades` — the sidebar hooks (`useImportUpgrade`,
  `useLatestVersions`) hand-roll the rewrite — so it takes the new response shape
  and keeps dropping pins for now. Moving it onto the shared builder is what
  would give it pinning, and that is a change to the editor's UI, not to this
  seam.

## After the change

An author's `imports:` block, before — pinned, one version behind, and one entry
at the latest version with no pin at all:

```yaml
imports:
  Console:
    source: oci://ghcr.io/telorun/console@0.9.0
    integrity: sha256-3q2-7-8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
  Sql: oci://ghcr.io/telorun/sql@1.4.0
```

`Console` shows `↑ 0.9.0 → 0.10.0` and `Sql` shows a pin affordance. Applying
both leaves every import pinned, each in the shape it was written in:

```yaml
imports:
  Console:
    source: oci://ghcr.io/telorun/console@0.10.0
    integrity: sha256-DcYm3q2-7-8AAAAAAAAAAAAAAAAAAAAAAAAAAAA
  Sql: oci://ghcr.io/telorun/sql@1.4.0#sha256-9WxK1p4-2-QAAAAAAAAAAAAAAAAAAAAAAAA
```

## Verification & bookkeeping

`packages/ide-support/tests/import-upgrades.test.ts` covers each written shape
(scalar, object-form, flow-style) across both categories, the no-integrity
fallback, and a malformed pin from a hostile hub.

The CLI half is `cli/nodejs/tests/module-manifest.test.ts`, over an extracted
`buildManifestJsonPayload`. It lives there because the hub e2e **cannot** cover
it: that container tracks with the `telo` its base image ships, never the
workspace one, so a field added to the command is invisible to it until a CLI
release lands in `telorun/node` and `TELO_NODE_VERSION` is bumped. Until then
`apps/hub/tests/e2e/discovery-routes.yaml` asserts the shape of `integrity` but
cannot require it — the comment there names the condition for tightening it.
End to end: upgrade in VS Code, then `telo install`, and the pin verifies against
origin-fetched bytes.

Changesets for `@telorun/ide-support` and the CLI package, and a changie
fragment for `hub` — `apps/hub` is a changie project (`.changes/hub/`) even
though it is not under `modules/`. `ide/vscode` is neither, and needs none.
`ide/vscode/README.md` no longer says the lens strips pins.
