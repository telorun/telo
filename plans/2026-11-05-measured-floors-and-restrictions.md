---
status: approved
priority: medium
depends-on: []
packages: [analyzer/nodejs, kernel/nodejs, cli/nodejs, scripts, packages/language-host, packages/language-server, packages/ide-support, apps/hub, apps/authoring-agent, docs]
---

# Measured floors and post-publish restrictions

## Problem

**The floor is a guess.** A module adopting new syntax writes `requires: telo: ">=X"`, where `X` is the last published telo plus the strongest pending changeset bump at the moment of writing. That number goes wrong three ways:

- a release lands while the branch is open, and after a rebase `X` names a published release that lacks the syntax — caught only when that CLI rejects the file statically;
- a stronger bump lands later, and `X` names a version that is never published;
- no telo-line changeset is pending yet, so `X` is the current version and the edge check reports it passed without running anything.

**A published range cannot be amended.** A published `telo.yaml` is fixed: consumer pins hash it, and publish refuses different bytes at the same version. Publishing a patch with an upper bound does not help: `telo upgrade` walks newest-first, skips the bounded patch and selects the older open-ended version — the broken one.

## Solution

- **`requires.telo` holds only what tooling measures.** In a release workspace it equals the lowest published telo that reads the module's syntax, `>=unreleased` when none does, or is absent when every telo that reads `requires:` accepts it. Nobody writes it by hand.
- **Everything an author knows that measurement cannot see is a `restrictions:` entry with a reason**: a ceiling found after publish, a floor the static check cannot see, a Node bound found later. An entry narrows the range of the version declaring it and of earlier versions; a later version speaks for earlier ones, as Go's `retract` does. The restriction travels in the manifest every channel already carries: no registry state, no new file, no protocol change, any transport.

### The floor

**Grammar.** `requires.telo` is floor-only.

- It is `">=<version>"` or `">=unreleased"`. `unreleased` means "the telo release that carries the pending telo-line changesets".
- An upper bound on `telo` in a module's own source is `REQUIRES_INVALID`, and its message names a `restrictions:` entry. An upper bound in an already-published manifest is still read and honoured, as a restriction covering that version only.
- `requires.host.node` keeps both bounds, as today.
- An `X+unreleased` build satisfies `>=unreleased`. A released telo answers `MODULE_REQUIRES_NEWER_RUNTIME` for it.
- Editor `auto` version selection treats `>=unreleased` as satisfied only by an unreleased engine.

**Measurement.** A module is measured as a copy with the candidate floor in place and every bound inside its `restrictions:` entries replaced by one the measuring process meets — each `telo` bound by the candidate floor, each host bound by `>=0.0.0` — while every key of every entry stays, so syntax inside an entry still counts. `requires.telo` is therefore the static floor alone; entries narrow it at load and selection, never feed it. `telo release floor`, `telo release check` and the publish preflight all run this copy. Modules are measured in import order, siblings first, so a dependent sees its sibling's new floor.

- `telo check` from the published `@telorun/cli` decides acceptance, with the same attributable-output rule the edge check uses today.
- **V0** is the oldest published CLI that reads `requires:` — a constant, found once by execution during implementation. If V0 accepts the module, the measured floor is none.
- Otherwise it is the lowest published, non-prerelease release that accepts the module, found by binary search between V0 and the latest; support only grows in newer versions.
- If no published release accepts it, it is `>=unreleased`.
- If the registry cannot be reached, or a run cannot be attributed to the manifest, the command fails and writes nothing.

**`telo release floor [--module <dir>]`** writes the measured floor of each workspace module, up or down, and removes `requires.telo` when the measured floor is none.

**`telo release check`** verifies each distinct floor F without writing: the CLI at F accepts and the published release just below F rejects attributably, and a floor-less module is accepted by V0. It fails with:

- `REQUIRES_FLOOR_TOO_LOW` — the floor is below the measured one, or missing while V0 rejects the module;
- `REQUIRES_FLOOR_TOO_HIGH` — the floor is above the measured one: a `>=unreleased` a published release now accepts, a number raised by hand, a floor at or below V0, or a number naming no published release (unless it is the line version the version step just wrote).

Both name the measured value and `telo release floor`. They replace today's "refuted" outcome.

**The version step** (`version-packages`, after `changeset version`) rewrites every `>=unreleased` in the workspace's module manifests — in `requires.telo` and in `restrictions:` entries — to the version it just assigned the telo line, splicing the text so the layout is kept. The rewritten modules then move on the module track as usual.

**`telo publish`** refuses a manifest holding `>=unreleased` anywhere, or whose `requires.telo` declares an upper bound. It keeps the existing preflight that runs the CLI at the floor (over the measurement copy), which is the only verification a third-party author outside a release workspace gets. Those authors keep writing floors by hand, against released versions, as they do today.

**Example.** `Geocode` 1.2.0 marks `address` with `x-telo-span-attribute`, assumed here to be syntax no published telo reads yet. `GeocodeCache` in the same workspace imports it by relative path.

Before — the floor and ceiling written by hand:

```yaml
kind: Telo.Library
metadata:
  name: Geocode
  version: 1.2.0
  license: MIT
  description: Turns a street address into latitude and longitude through a geocoding API.
requires:
  telo: ">=0.119.0 <0.121.0"
exports:
  kinds: [Lookup]
---
kind: Telo.Definition
metadata:
  name: Lookup
  description: Looks up one address and returns its latitude and longitude.
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/geocode.mjs&local_path=./nodejs/src/index.ts#Lookup
schema:
  type: object
  properties: { apiKey: { type: string } }
  required: [apiKey]
inputType:
  type: object
  properties: { address: { type: string, x-telo-span-attribute: geocode.address } }
  required: [address]
outputType:
  type: object
  properties: { latitude: { type: number }, longitude: { type: number } }
  required: [latitude, longitude]
```

`telo check` refuses the ceiling in source:

```console
$ telo check modules/geocode/telo.yaml
modules/geocode/telo.yaml:8:9 error REQUIRES_INVALID requires.telo '>=0.119.0 <0.121.0' declares an upper bound; requires.telo is a floor only. Write the ceiling as a restrictions: entry without versions, which covers this version.
```

The author deletes the `requires:` block and runs the floor command over the workspace:

```console
$ telo release floor
modules/geocode: (none) → >=unreleased (no published telo accepts it; 0.120.3 reports SPAN_ATTRIBUTE_MISPLACED at telo.yaml:25)
modules/geocode-cache: >=0.118.0 → >=unreleased (imports modules/geocode at >=unreleased)
modules/kv-store: >=0.112.0 unchanged
modules/console: >=0.80.0 → (none) (accepted by 0.64.0, the oldest telo that reads requires:)
```

After, in source:

```yaml
kind: Telo.Library
metadata:
  name: Geocode
  version: 1.2.0
  license: MIT
  description: Turns a street address into latitude and longitude through a geocoding API.
requires:
  telo: ">=unreleased"
exports:
  kinds: [Lookup]
---
kind: Telo.Definition
metadata:
  name: Lookup
  description: Looks up one address and returns its latitude and longitude.
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/geocode.mjs&local_path=./nodejs/src/index.ts#Lookup
schema:
  type: object
  properties: { apiKey: { type: string } }
  required: [apiKey]
inputType:
  type: object
  properties: { address: { type: string, x-telo-span-attribute: geocode.address } }
  required: [address]
outputType:
  type: object
  properties: { latitude: { type: number }, longitude: { type: number } }
  required: [latitude, longitude]
```

A released telo checking that source:

```console
$ npx @telorun/cli@0.120.3 check modules/geocode/telo.yaml
modules/geocode/telo.yaml:8:9 error MODULE_REQUIRES_NEWER_RUNTIME Geocode requires telo '>=unreleased'; this runtime reports 0.120.3. Upgrade telo.
```

If the branch merges first, the Version PR assigns the telo line `0.121.0` and writes the number:

```console
$ pnpm run version-packages
@telorun/sdk, @telorun/cel, @telorun/message-format, @telorun/templating, @telorun/analyzer, @telorun/kernel, @telorun/cli, @telorun/ide-support, @telorun/language-server → 0.121.0
modules/geocode/telo.yaml: requires.telo >=unreleased → >=0.121.0
modules/geocode-cache/telo.yaml: requires.telo >=unreleased → >=0.121.0
```

If instead telo 0.121.0, which carries the syntax, is published while the branch is open, the branch's check fails after the rebase, and the floor command corrects it:

```console
$ telo release check
modules/geocode: REQUIRES_FLOOR_TOO_HIGH requires.telo is '>=unreleased'; published telo 0.121.0 accepts this module. Run `telo release floor --module modules/geocode`.
modules/geocode-cache: REQUIRES_FLOOR_TOO_HIGH requires.telo is '>=unreleased'; published telo 0.121.0 accepts this module. Run `telo release floor --module modules/geocode-cache`.
modules/kv-store: REQUIRES_FLOOR_TOO_LOW requires.telo is '>=0.112.0'; telo 0.112.0 reports X_TELO_REF_INVALID_OUTPUT_TO at telo.yaml:61, and the lowest published telo that accepts this module is 0.115.0. Run `telo release floor --module modules/kv-store`.
modules/crypto: REQUIRES_FLOOR_TOO_LOW requires.telo is missing; telo 0.64.0 reports SCHEMA_VIOLATION at telo.yaml:40, and the lowest published telo that accepts this module is 0.71.0. Run `telo release floor --module modules/crypto`.
4 modules failed.
$ telo release floor
modules/geocode: >=unreleased → >=0.121.0
modules/geocode-cache: >=unreleased → >=0.121.0
modules/kv-store: >=0.112.0 → >=0.115.0
modules/crypto: (none) → >=0.71.0
modules/console: (none) unchanged
```

The registry unreachable:

```console
$ telo release floor
error: cannot list published @telorun/cli versions from https://registry.npmjs.org/@telorun%2fcli (ENOTFOUND); nothing was written.
```

`telo publish` on a floor still waiting for its release, on a requirement entry still waiting for one, and on a ceiling written outside a release workspace:

```console
$ telo publish modules/geocode
error: modules/geocode/telo.yaml holds '>=unreleased' at requires.telo; publish after the telo release that carries it, once the Version PR has written the number.
$ telo publish modules/geocode-cache
error: modules/geocode-cache/telo.yaml holds '>=unreleased' at restrictions[0].requires.telo; publish after the telo release that carries it, once the Version PR has written the number.
$ telo publish ../acme-geocode
error: ../acme-geocode/telo.yaml: requires.telo '>=0.119.0 <0.121.0' declares an upper bound; requires.telo is a floor only. Write the ceiling as a restrictions: entry without versions, which covers this version.
```

### Restrictions

**Shape.** An optional top-level `restrictions:` list on a `Telo.Application` or `Telo.Library` doc. Each entry is:

- `versions` — optional. A range of this module's own versions, in the `requires` comparator grammar. A version speaks for itself and earlier ones, never for a later one: a range with no upper bound is closed at the declaring doc's own version, whatever the module track later makes it (`">=1.2.0"` is "1.2.0 through this version"), and an explicit upper bound above the current `metadata.version` is refused. Without `versions`, the entry covers only the declaring doc.
- `requires` — the same shape as the top-level `requires:` block (`telo`, `host.node`), stating at least one bound. Floors and ceilings are both allowed. `>=unreleased` is allowed only as a `telo` floor.
- `reason` — required, shown to whoever is held back.

A malformed entry, or one that leaves the declaring version usable by no runtime when it covers it, is `RESTRICTIONS_INVALID`, refused by `telo check` and by the kernel at load. A bound naming no published telo release is refused as it is in `requires:` today.

**Meaning.**

- **At load**, a version's range is its own `requires` narrowed by its own entries that cover it. The gate reads only the pinned version's own bytes, so a pinned run stays deterministic and works offline; a restriction a later version adds never breaks an installed pin.
- **At selection** (`telo upgrade`, editor upgrade lenses and version pickers), a candidate's range is its load range narrowed, for each requirement key (`telo`, `host.node`), by the covering entries on that key of the newest published version newer than the candidate that has any entry covering it and stating that key. Prereleases speak only when no release exists. `telo upgrade` already reads every manifest newer than the version it selects, so this costs no extra request. It also names the reason when the current pin falls under such an entry.
- **Omitting** an entry from a later version lifts nothing: the older statement holds. **Lifting** is stating the key again from a newer version, with an entry covering the same versions. A version can never be widened past what was verified when it was published, and its own entries always apply to it.

**The gate codes.**

- Running above a ceiling (from an entry, or from an already-published manifest's upper bound) is `MODULE_REQUIRES_OLDER_RUNTIME`, an error that names the reason and advises an older runtime or another version of the module.
- Running below an entry's floor is `MODULE_REQUIRES_NEWER_RUNTIME`, with the entry's reason in the message.
- Both suppress the module's other diagnostics, as today's gate does.
- Today a runtime above an upper bound gets `MODULE_REQUIRES_NEWER_RUNTIME` and "Upgrade telo". That wording is replaced by the new code.

One effective-range function in the analyzer's requires reader serves the CLI, the kernel, the editor engine and `telo upgrade`. The editor engine reads candidates through `telo/read`, as it does today. It reports each module's load range as the interval `telo/requirements` already carries, and the language-host keeps comparing plain versions against it; `>=unreleased` is reported with a lower edge no released version meets, so selection falls to the bundled engine as for any unsatisfiable range. The editor protocol is unchanged.

**Example — a floor measurement cannot see.** After telo 0.121.0, `GeocodeCache` 0.4.0 keeps its cache across a reload, which only the unreleased kernel supports. Static checking accepts the module on 0.121.0, so measurement writes `>=0.121.0`, and the author states the requirement as an entry without `versions`:

```yaml
kind: Telo.Library
metadata:
  name: GeocodeCache
  version: 0.4.0
  license: MIT
  description: Remembers geocoding answers, so a repeated address costs one API call, and keeps them across a reload.
requires:
  telo: ">=0.121.0"
restrictions:
  - requires: { telo: ">=unreleased" }
    reason: CachedLookup keeps its cache across a reload, which kernels before this release drop on every reload.
imports:
  Geocode: ../geocode
exports:
  kinds: [CachedLookup]
---
kind: Telo.Definition
metadata:
  name: CachedLookup
  description: Looks up one address through a geocoding lookup and returns the remembered answer when the address was seen before.
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/geocode-cache.mjs&local_path=./nodejs/src/index.ts#CachedLookup
schema:
  type: object
  properties: { lookup: { x-telo-ref: { kind: Geocode.Lookup, use: call } } }
  required: [lookup]
inputType:
  type: object
  properties: { address: { type: string } }
  required: [address]
outputType:
  type: object
  properties: { latitude: { type: number }, longitude: { type: number } }
  required: [latitude, longitude]
```

Measurement replaces the entry's bound, so `requires.telo` stays the static floor, while telo 0.121.0 refuses the module at load through the entry:

```console
$ npx @telorun/cli@0.121.0 run ./telo.yaml
error MODULE_REQUIRES_NEWER_RUNTIME GeocodeCache requires telo '>=unreleased'; this runtime reports 0.121.0. Reason: CachedLookup keeps its cache across a reload, which kernels before this release drop on every reload. Upgrade telo.
```

The Version PR writes the entry's number:

```console
$ pnpm run version-packages
@telorun/sdk, @telorun/cel, @telorun/message-format, @telorun/templating, @telorun/analyzer, @telorun/kernel, @telorun/cli, @telorun/ide-support, @telorun/language-server → 0.122.0
modules/geocode-cache/telo.yaml: restrictions[0].requires.telo >=unreleased → >=0.122.0
```

**Example — a ceiling found after publish.** `Geocode` 1.2.0 shipped with `>=0.121.0`. Telo 0.122.0 and Node 24 each later broke its controller, and no fix exists yet.

An application using it:

```yaml
kind: Telo.Application
metadata:
  name: StoreLocator
  version: 1.0.0
secrets:
  geocodeKey: { env: GEOCODE_API_KEY, type: string }
imports:
  Geocode: oci://ghcr.io/acme/geocode@1.2.0#sha256-9c2f4b7e1a0d3c58e6f7a9b2c4d1e0f3a5b7c9d2e4f6a8b0c1d3e5f7a9b2c4d6
targets:
  - name: locate
    invoke:
      kind: Geocode.Lookup
      apiKey: !cel "secrets.geocodeKey"
    inputs: { address: "1 Market St, San Francisco" }
```

Before — the author publishes 1.2.1 with `requires: { telo: ">=0.121.0 <0.122.0" }`, and on telo 0.122.0 upgrade leaves the app on the broken version with nothing said about it:

```console
$ telo upgrade ./telo.yaml
Geocode: oci://ghcr.io/acme/geocode@1.2.0 is the newest version this telo can use.
  held back: 1.2.1 requires telo '>=0.121.0 <0.122.0'; this runtime reports 0.122.0.
```

After — the author publishes 1.2.1 with the same code and restrictions covering 1.2.0 through itself. The doc was still at 1.2.0 when they wrote it; `telo release apply` moved it to 1.2.1, and `">=1.2.0"` follows:

```yaml
kind: Telo.Library
metadata:
  name: Geocode
  version: 1.2.1
  license: MIT
  description: Turns a street address into latitude and longitude through a geocoding API.
requires:
  telo: ">=0.121.0"
restrictions:
  - versions: ">=1.2.0"
    requires: { telo: "<0.122.0" }
    reason: Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.
  - versions: ">=1.2.0"
    requires: { host: { node: "<24.0.0" } }
    reason: Lookup's HTTP client crashes on Node 24; a fix ships in 1.3.0.
exports:
  kinds: [Lookup]
---
kind: Telo.Definition
metadata:
  name: Lookup
  description: Looks up one address and returns its latitude and longitude.
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/geocode.mjs&local_path=./nodejs/src/index.ts#Lookup
schema:
  type: object
  properties: { apiKey: { type: string } }
  required: [apiKey]
inputType:
  type: object
  properties: { address: { type: string, x-telo-span-attribute: geocode.address } }
  required: [address]
outputType:
  type: object
  properties: { latitude: { type: number }, longitude: { type: number } }
  required: [latitude, longitude]
```

On telo 0.122.0, `StoreLocator` pinned to 1.2.0, and the same application pinned to 1.1.0:

```console
$ telo upgrade ./telo.yaml
Geocode: oci://ghcr.io/acme/geocode@1.2.0 is restricted by 1.2.1: Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.
  held back: 1.2.1 — Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.
$ telo upgrade ./telo.yaml
Geocode: oci://ghcr.io/acme/geocode@1.1.0 is the newest version this telo can use.
  held back: 1.2.1 and 1.2.0 — Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.
```

The pin to 1.2.0 still loads: its own bytes carry no restriction. `StoreLocator` pinned to 1.2.1 on the same telo — before, then after:

```console
$ telo run ./telo.yaml
error MODULE_REQUIRES_NEWER_RUNTIME Geocode requires telo '>=0.121.0 <0.122.0'; this runtime reports 0.122.0. Upgrade telo.
```

```console
$ telo run ./telo.yaml
error MODULE_REQUIRES_OLDER_RUNTIME oci://ghcr.io/acme/geocode@1.2.1 is restricted to telo '<0.122.0'; this runtime reports 0.122.0. Reason: Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0. Use telo below 0.122.0, or another version of Geocode.
```

**Example — a later release, then a lift.** The fix, 1.3.0, needs telo `>=0.123.0` and carries no entries. On telo 0.122.0 nothing changes: 1.3.0 is out of range, and 1.2.1's statements still hold for 1.2.0 and 1.2.1, because omitting an entry lifts nothing:

```console
$ telo upgrade ./telo.yaml
Geocode: oci://ghcr.io/acme/geocode@1.1.0 is the newest version this telo can use.
  held back: 1.3.0 requires telo '>=0.123.0'; this runtime reports 0.122.0.
  held back: 1.2.1 and 1.2.0 — Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.
```

Telo 0.122.1 then fixes the regression on its side. The author lifts the `telo` ceiling for the 1.2 line by stating the key again from 1.3.1; the Node 24 ceiling, not restated, still holds:

```yaml
kind: Telo.Library
metadata:
  name: Geocode
  version: 1.3.1
  license: MIT
  description: Turns a street address into latitude and longitude through a geocoding API.
requires:
  telo: ">=0.123.0"
restrictions:
  - versions: ">=1.2.0 <=1.2.1"
    requires: { telo: ">=0.121.0" }
    reason: Lookup works on every telo again since telo 0.122.1 fixed the regression.
exports:
  kinds: [Lookup]
---
kind: Telo.Definition
metadata:
  name: Lookup
  description: Looks up one address and returns its latitude and longitude.
capability: Telo.Invocable
controllers:
  - pkg:telo/local/js?path=./nodejs/geocode.mjs&local_path=./nodejs/src/index.ts#Lookup
schema:
  type: object
  properties: { apiKey: { type: string } }
  required: [apiKey]
inputType:
  type: object
  properties: { address: { type: string, x-telo-span-attribute: geocode.address } }
  required: [address]
outputType:
  type: object
  properties: { latitude: { type: number }, longitude: { type: number } }
  required: [latitude, longitude]
```

On telo 0.122.1 with Node 22, `StoreLocator` pinned to 1.1.0. 1.2.1 stays held back by its own entry, which always applies to it:

```console
$ telo upgrade ./telo.yaml
Geocode: oci://ghcr.io/acme/geocode@1.1.0 → 1.2.0
  held back: 1.3.1 and 1.3.0 require telo '>=0.123.0'; this runtime reports 0.122.1.
  held back: 1.2.1 — Lookup never returns on telo 0.122.0 and later; a fix ships in 1.3.0.
```

Refused entries:

```yaml
kind: Telo.Library
metadata:
  name: Geocode
  version: 1.2.1
  license: MIT
  description: Turns a street address into latitude and longitude through a geocoding API.
requires:
  telo: ">=0.121.0"
restrictions:
  - versions: "<=1.3.0"
    requires: { telo: "<0.122.0" }
    reason: Lookup never returns on telo 0.122.0 and later.
  - versions: "<=1.2.1"
    requires: { telo: "<0.121.0" }
    reason: Broken everywhere.
  - versions: "<=1.2.0"
    requires: { telo: "<0.122.0" }
  - requires: {}
    reason: Held back.
  - requires: { host: { node: ">=unreleased" } }
    reason: Needs the next Node.
```

```console
$ telo check modules/geocode/telo.yaml
modules/geocode/telo.yaml:10:15 error RESTRICTIONS_INVALID restrictions[0].versions '<=1.3.0' reaches past this module's version 1.2.1; an entry covers only this version and earlier ones. Leave the upper bound off to cover through this version.
modules/geocode/telo.yaml:13:5 error RESTRICTIONS_INVALID restrictions[1] leaves 1.2.1 usable by no telo: requires.telo '>=0.121.0' and '<0.121.0' do not overlap. Deprecate the module instead.
modules/geocode/telo.yaml:16:5 error RESTRICTIONS_INVALID restrictions[2] has no reason; say what breaks, so whoever is held back knows why.
modules/geocode/telo.yaml:18:15 error RESTRICTIONS_INVALID restrictions[3].requires states no bound.
modules/geocode/telo.yaml:20:31 error RESTRICTIONS_INVALID restrictions[4].requires.host.node '>=unreleased': unreleased names a telo release and is allowed only as a telo floor.
```

## Delivery

- Run `telo release floor` once over the workspace in this change. Before it, every existing floor the run would lower is either confirmed unneeded or moved into a `restrictions:` entry without `versions`, carrying its reason; when the reason is unknown it is moved. Every module whose floor moves, is added or is removed, or which gains an entry, gets a `Fixed` fragment through `telo release add`.
- `restrictions:` is new manifest syntax; a module that adopts it is floored by measurement like any other.
- `RESTRICTIONS_INVALID` has its kernel twin at load, and both halves join `tests/check-run-agreement.yaml`.
- Changesets: one for the telo line (analyzer, kernel, cli, ide-support, language-server), plus `@telorun/language-host`. The hub releases on its own track.
- Docs:
  - `docs/extend/declaring-runtime-requirements.md` is rewritten around measured floors, `>=unreleased`, a floor-less module being correct when V0 accepts it, and `restrictions:` for every requirement measurement cannot see.
  - `docs/extend/releasing-modules.md` gains `telo release floor` and restricting a published version by publishing a later one: a restriction only changes selection, a fixed later version is selected as usual, an entry a later version omits still holds, and lifting is restating the key from a later version; a range with no upper bound runs through the declaring version.
- Guides:
  - The root `CLAUDE.md` § Changing the grammar becomes "run `telo release floor`"; § Declared runtime requirements says `requires.telo` is never hand-written in a release workspace; the rule that a module whose controllers return effect chains declares `>=0.82.0` becomes a `restrictions:` entry wherever the measured floor does not already imply it.
  - The analyzer and CLI guides' `requires:` sections are updated.
  - The authoring-agent primer's `requires:` passages, and the hub's library-design guide where it mentions `requires:`, are updated.
- Benefits ledger: the existing "Runtime requirements" entry is extended. Floors are computed for you, and a later version can hold back earlier ones from upgrades on the telo or Node releases they break on.
- Polyglot debt: `cli/rust` owes `telo release floor` as it owes `telo publish`. The Rust kernel reads no `requires:` today, so it is unaffected.

## Verify

**Floor**
- A module adopting unreleased builtins syntax: `telo release floor` writes `>=unreleased`, and `telo release check` passes. The npm Version PR rewrites it to the same version it gives `@telorun/cli`.
- Rebasing that branch over the release that carries the syntax: `telo release check` fails `REQUIRES_FLOOR_TOO_HIGH` naming that release, and `telo release floor` writes it. Rebasing over an unrelated release changes nothing.
- A floor set too low by hand fails `REQUIRES_FLOOR_TOO_LOW`; a number raised by hand fails `REQUIRES_FLOOR_TOO_HIGH`; both name the measured value.
- A floor-less module that V0 accepts passes with nothing written; one V0 rejects fails `REQUIRES_FLOOR_TOO_LOW`. A floor at or below V0 fails `REQUIRES_FLOOR_TOO_HIGH`, and `telo release floor` removes it.
- `telo release check` on an unchanged module costs two CLI runs per distinct floor.
- `Geocode` 1.2.1 with its `telo` and `host.node` ceiling entries passes `telo release check` at `>=0.121.0`, on Node 22 and Node 24 alike. A host key that only a newer telo reads, used inside an entry, raises the measured floor.
- A dependent of a sibling at `>=unreleased` is measured to `>=unreleased`.
- `telo publish` refuses `>=unreleased` in `requires.telo` and in an entry, and refuses an upper bound on `requires.telo`. `telo check` reports that upper bound in source as `REQUIRES_INVALID`; `requires.host.node` with an upper bound still passes.
- An already-published manifest declaring a `telo` upper bound still refuses a telo above it, with `MODULE_REQUIRES_OLDER_RUNTIME`.

**Restrictions**
- `GeocodeCache` 0.4.0 with a `telo: ">=unreleased"` entry without `versions`: measurement keeps `requires.telo` at its static floor `>=0.121.0`, the Version PR rewrites only the entry, and the entry still applies after the module track moves the doc to 0.4.1. On telo 0.121.0 the load gate reports `MODULE_REQUIRES_NEWER_RUNTIME` with the entry's reason.
- In a workspace at 1.2.0, `versions: ">=1.2.0"` passes `telo check`; after `telo release apply` moves the doc to 1.2.1, the published entry covers 1.2.0 and 1.2.1. `versions: "<=1.2.0"` written at 1.2.0 still passes after the bump and does not cover 1.2.1.
- Publish `Geocode` 1.2.0 with `>=0.121.0`, then 1.2.1 with the two entries above.
  - On telo 0.122.0, `telo upgrade` of a manifest pinned to 1.1.0 selects neither 1.2.x and names the reason; of a manifest pinned to 1.2.0 it reports the pin as restricted. On 0.121.0 with Node 22 it selects 1.2.1; on Node 24 it selects neither.
  - A pin on 1.2.0 still loads on 0.122.0, offline. A pin on 1.2.1 fails with `MODULE_REQUIRES_OLDER_RUNTIME`, offline, on telo 0.122.0 and on Node 24.
  - The 1.2.0 `telo.yaml` pin is unchanged and existing installs still verify.
- Publish 1.3.0 at `>=0.123.0` with no entries: on 0.122.0, `telo upgrade` from 1.1.0 still selects neither 1.2.x. Publish 1.3.1 restating `telo: ">=0.121.0"` for `>=1.2.0 <=1.2.1`: on 0.122.1 with Node 22 it selects 1.2.0, 1.2.1 stays held back by its own entry, and on Node 24 1.2.0 stays held back by 1.2.1's unrestated `host.node` entry.
- The same holds for a module served from an https URL and from `ghcr.io`, with no request beyond the manifests upgrade already reads.
- `telo check` and the kernel at load refuse the five entries of the refused example with `RESTRICTIONS_INVALID`.

**Editors**
- Studio web and VS Code on telo 0.122.0 offer no upgrade lens to 1.2.0 or 1.2.1, and show `MODULE_REQUIRES_OLDER_RUNTIME` on an existing pin to 1.2.1, with no change to `packages/editor-protocol`.
