# Native binary layers

## Problem

A module that needs a platform-specific binary cannot be bundled, so it stays on npm. That is why `sqlite` is still `pkg:npm`-delivered: better-sqlite3 locates its addon by walking up from `__filename`, which does not exist in an ESM bundle, so a bundled `SQLite.Connection` fails at creation with `ReferenceError: __filename is not defined`. It is also why `@telorun/sql` still publishes to npm at all — nothing outside this repo needs it to build.

Rust has the same gap from both ends. A Rust-authored controller can only be delivered as `pkg:cargo` built from a source checkout, and `pkg:telo/local/napi` / `pkg:telo/local/dylib` are reserved names no kernel hosts. Separately the Rust kernel cannot read a published artifact at all — its README lists `oci://` as unsupported, and it has no transport, layer index, selector, host detection, materializer or directory lock.

The layered artifact solves the addressing half: per-selector layers, a platform gate before materialization, and per-layer `blob` and `integrity` pinned inside `telo.yaml` so the import pin covers the binary. What is missing:

- **No ABI axis.** better-sqlite3 is not N-API — it ships prebuilds over `node-abi`, so each `.node` is valid for exactly one `NODE_MODULE_VERSION` (137 on Node 24). The axis-name set is closed and has no `abi`.
- **No layer role for a platform-specific file that is not a controller entry point.** Attaching a binary to a controller layer with `siblings=` forces the platform matrix into the candidate list — `sqlite` has four kinds each with its own `controllers:`, so twenty tuples is eighty PURL lines — and copies the 486 KB bundle into all twenty layers.
- **Nothing puts binaries on disk before publish.** No step fetches a release tarball or unpacks an npm platform package, and this repo's own Rust controllers publish no prebuilds to fetch.

## Solution

Six parts. Parts 1 and 2 are a **breaking artifact-format change**, sequenced below.

**1 — Format tolerance, shipped first and alone.** Today an index entry with an unknown `role` is skipped by the parser but rejected by the AJV index schema, whose `role` is a hard enum and whose `selector` is `additionalProperties: false`; and an unknown selector axis throws from the parser, which runs inside `kernel.load()` for every module in the graph, unguarded. So §3.1's forward-compatibility guarantee is not delivered end to end. This part completes it: the schema stops enumerating roles and stops closing the selector, and an entry carrying an unrecognized axis is skipped as an unrecognized role is. The rationale differs from the role rule — a runtime can genuinely need a layer whose axis it cannot name — and rests instead on the fact that skipping can never mis-match, whereas dropping the unknown axis would collide two layers onto one address.

**2 — The `abi` axis and the `native` role.** `abi` joins the axis set on the same footing as `libc`: a host-runtime property that decides whether a binary loads at all. Its value names whose ABI as well as which version — `node-137` for Node's `NODE_MODULE_VERSION`, `telo-2` for the Rust controller ABI — because a bare number is not an identity: Bun reports `process.versions.modules` as `137`, exactly as Node 24 does, and loads none of the addons built against it. So the Node kernel reports `node-<modules>` on Node and leaves `abi` undetermined on Bun, and the Rust kernel reports `telo-<controller ABI version>`. A layer that states no `abi` matches everywhere, so an N-API addon simply omits it. `native` is a new per-selector role for a platform-specific file the runtime does **not** import as a controller — a sidecar addon, a `dlopen`'d library, a per-platform data blob — declared once per module in a `native:` block whose entries carry a logical **name**, the selector axes, and the module-relative path. Controller candidates stay platform-neutral, so a module's kind count no longer multiplies its platform matrix, and the bundle ships once.

Paths are **not** flattened into the layer; the declared path is the in-layer path. The module directory is shared by every layer of a module and `telo install --platform` deliberately extracts a foreign platform's layers into it, while completion markers are keyed by blob with no selector and short-circuit before the lock — so a flat path is a cross-platform collision resolved by extraction order, and a warm following a run leaves a foreign binary behind a still-valid marker. Path-disjointness per tuple is therefore an invariant, not a convenience. Controller code never composes that path: it asks for a native file **by name**, and the kernel resolves the entry whose selector matches the host, materializes that layer and returns the URI. Nothing about the host tuple reaches the module, there is no placeholder to collide with the `!include-*` path grammar, and no string for a module to get wrong. Two formats for one tuple are two named entries, so cardinality is per name, never per platform.

**Sequencing.** Part 1 ships in release N and is the last release readable by everything before it. A module shipping an abi-bearing or `native`-bearing index is unreadable by every runtime older than N — not degraded, unreadable, because both failures occur while parsing the manifest during load. `requires:` cannot convert that into a good message; it is a diagnostic from `analyze()` and the failure is a throw on a different path. This is the same shape as `requires:` itself being a `SCHEMA_VIOLATION` on every analyzer released before it: unavoidable and unfixable retroactively. Modules therefore adopt these layers no earlier than release N+1, declaring `requires: telo: ">=N+1"` for the benefit of runtimes at or above N, and the release notes state the hard floor for those below. A layer with an executable or link entry is the milder case: a runtime still computing the old integrity line rejects it only at materialization, after the `requires:` gate has run, so the same floor reports it as `MODULE_REQUIRES_NEWER_RUNTIME`.

**3 — `telo release stage`.** Fetch only; nothing is built. Every staged file is extracted from an archive someone published — a GitHub release asset for better-sqlite3, an npm platform package's registry tarball for an N-API addon such as sharp — declared as data in a `sources:` block on the module doc, beside `native:`. A **source** names its upstream version once, a URL template over that version and the tuple, and the notice files covering what it ships; each **entry** under it names a module-relative path, the part of the URL that varies by tuple, the member to extract, and what lands — the `sha256` and executable bit of a file, or a link's target. Entries are keyed by path, because the manifest already names every staged file — a `native:` entry's path or a platform-qualified candidate's `path=` — and per-tuple paths make it unique. A digest mismatch and a declared file missing after staging are fatal; a network failure is fatal only when the file is not already staged and verified. Staged output is gitignored.

**The block is authoring input, and publish removes it.** The payload builder drops `sources:` from the manifest it publishes, as it drops `include:`, and does so before any sibling pin is derived from that manifest, so a pin names the text the registry serves. With both lists in one file, `telo check` reports a source entry whose path neither a `native:` entry nor a platform-qualified candidate names; a named path no source stages must be checked in, and publish refuses it when it is not.

**Pins are written by a command and verified everywhere else**, as import pins are. `telo release stage --pin` fetches every entry, hashes what lands and writes it into the `sources:` block, through the same minimal-edit writer `telo install` uses for an import pin; plain `telo release stage` only verifies. A better-sqlite3 bump is therefore one edited version and one `--pin` run, not twenty URLs and twenty digests.

**A staged binary ships with its notices.** Publishing a prebuild makes telo its distributor, and the obligation travels with every copy: better-sqlite3's MIT notice, libvips' LGPL-3.0 text, and the notices of every crate a Rust prebuild links. A source's notice files are module-relative — checked in, or staged like any other entry — and platform-neutral: naming them in the source is what puts them in the payload, in the `common` layer, with no `files:` entry; publish refuses a source that names none.

**No gate stages, and none needs to.** A layer's integrity is a digest over each file's path and content digest, so a staged file contributes its pin rather than its bytes: every layer's integrity is computable on a tree where nothing is staged, and it is the same number publish derives from the bytes and the registry serves. Every command computing a payload digest reads the pins, so a fork's cold tree digests exactly as publish does; only publish needs the files on disk.

**This repo's Rust controllers are prebuilt the same way.** A CI matrix builds each crate per tuple on per-OS runners, generates the notice file for the crates each binary links, publishes both as release assets and re-pins them through `telo release stage --pin`; the module stages them like any other prebuild. Each pin also records a digest of the inputs it was built from — the crate's sources, its path dependencies and its lockfile — and `telo release check` fails when those inputs move without a re-pin, so a module never ships binaries older than its source. The path dependencies include the SDK and ABI crates, so a Rust controller ABI bump trips that check for every Rust prebuild.

**A new ABI is a re-pin, and nothing covers the gap before it.** With no `node-gyp` fallback, a Node major the module ships no layer for is unsupported until upstream publishes that ABI's prebuilds, the module re-pins and republishes, and its consumers move their pin. A scheduled CI job checks each source's upstream for ABIs its entries lack and opens the re-pin as a PR, so that lag is a PR awaiting review rather than a report from a host that just upgraded.

**4 — The Node `napi` loader.** `pkg:telo/local/napi` becomes hostable, so a Rust-authored controller is distributable as a published artifact. A `.node` addon has no ESM shape, so the loader opens it through `createRequire` and selects the candidate's fragment from the addon's exports object rather than through `await import()`. The candidate classifier that gates runtime reach on `format === "js"` gains `napi` and `dylib`; both report no language, since either may be Rust, C++ or Zig. Reach also narrows by a module's `native:` entries: a module declaring them reports the platforms and ABIs they cover beside its per-kind runtimes, in `telo module manifest --json` and so in the hub, since its kinds load nowhere else. It is per module — no kind declares which native name it uses — and derived, like the rest of reach.

**5 — The Rust kernel's artifact stack.** The largest part, and the only thing that makes `dylib` mean anything: an OCI manifest source with its HTTP, tar and digest support, the layer index parser, the selector over the shared axis vocabulary, host, libc and abi detection, the materializer and the directory lock — each mirroring its Node counterpart one-for-one as the file-layout rule requires — plus the `dylib` loader opening a cdylib over `telorun-abi`. A `dylib` layer states `abi=telo-<version>`, so one built against another controller ABI never matches rather than being fetched and refused. The Rust README's unsupported list loses `oci://`.

**6 — Consumers.** `sqlite` keeps one platform-neutral candidate per kind, declares its twenty native entries under one name, and passes the addon path explicitly instead of letting the package search for it. Its Bun branch moves off the `@telorun/sqlite/sqlite-driver` subpath export — a hard build error in the bundled seam — to a computed dynamic import of `bun:sqlite`, which esbuild leaves external and only Bun ever resolves; the module declares no `exports.code:` and needs none. `starlark` and `console` gain `napi` / `dylib` candidates and their first `requires:` blocks. `image` (an N-API addon in per-platform npm packages) and `pdf` are unblocked follow-on consumers.

## Authoring surface

One controller candidate per kind, unchanged. One `native:` block, each entry naming a logical name, `format`, `os`, `arch`, optional `libc`, optional `abi`, and the module-relative path. `format` is `node` for an addon built against one Node ABI, which therefore states `abi`, and `napi` for an N-API addon, which states none. Entries for darwin and windows omit `libc`, undetermined off Linux and therefore matching nothing if constrained. Controller code asks for a native file by its logical name. A `sources:` block beside `native:` says where every staged file comes from; publish removes it. `telo install` keeps `--platform os/arch[/libc]` exactly as it parses today and gains a separate `--abi` taking a qualified value (`--abi node-141`); omitted, abi is undetermined, no abi-constrained layer is warmed, and install reports what it skipped.

The matrix is the ten tuples better-sqlite3 ships, in the OCI/GOOS vocabulary the spec mandates: `linux` × `amd64` / `arm64` / `arm` at `libc` `gnu` and `musl`, `darwin` × `amd64` / `arm64`, `windows` × `amd64` / `arm64` — times ABI `node-137` and `node-141`. A host outside that set — a Node release past `node-141`, say — loads the module and fails when a connection is created, with the dedicated error naming the host and the tuples the module ships; the set itself is visible before anything runs, in the module's reported reach. Republishing with new layers is what extends it.

## Examples

**`modules/sqlite/telo.yaml`, authored.** One platform-neutral candidate per kind. The platform matrix lives once, in `native:`; where each file comes from lives in `sources:`, which publish removes. `telo release stage --pin` writes every `sha256`, so a better-sqlite3 bump edits `version` alone.

```yaml
kind: Telo.Library
metadata:
  name: SQLite
  # …
requires:
  # … the existing reasons
  # N+1: the `native:` and `sources:` blocks and the `native` layer role,
  # which an older analyzer rejects on the module doc.
  telo: ">=N+1"
imports:
  Sql: ../sql
exports:
  kinds: [Connection, Table, Enum, Schema]
native:
  - name: better-sqlite3
    format: node
    os: linux
    arch: amd64
    libc: gnu
    abi: node-137
    path: ./native/linux-amd64-gnu-node-137/better_sqlite3.node
  - name: better-sqlite3
    format: node
    os: linux
    arch: amd64
    libc: musl
    abi: node-137
    path: ./native/linux-amd64-musl-node-137/better_sqlite3.node
  - name: better-sqlite3
    format: node
    os: darwin
    arch: arm64
    abi: node-141
    path: ./native/darwin-arm64-node-141/better_sqlite3.node
  # … twenty entries: ten tuples × node-137, node-141
sources:
  better-sqlite3:
    version: 12.8.0
    url: https://github.com/WiseLibs/better-sqlite3/releases/download/v{version}/better-sqlite3-v{version}-{upstream}.tar.gz
    notices: [./notices/better-sqlite3.LICENSE]
    entries:
      ./native/linux-amd64-gnu-node-137/better_sqlite3.node:
        upstream: node-v137-linux-x64
        member: build/Release/better_sqlite3.node
        sha256: 4c9e…b21f
        executable: false
      ./native/linux-amd64-musl-node-137/better_sqlite3.node:
        upstream: node-v137-linuxmusl-x64
        member: build/Release/better_sqlite3.node
        sha256: 0a7d…93ce
        executable: false
      # … one entry per `native:` path
---
kind: Telo.Definition
metadata:
  name: Connection
capability: Telo.Provider
extends: Sql.Connection
controllers:
  # was: pkg:npm/@telorun/sqlite@0.4.0?local_path=./nodejs#connection
  - pkg:telo/local/js?path=./nodejs/sqlite.mjs&local_path=./nodejs/src/index.ts#ConnectionController
```

**The published `telo.yaml`.** `sources:` is gone and `native:` ships unchanged; a lookup by name picks the entry matching the host, and that entry's selector names its layer.

```yaml
layers:
  - role: controller
    selector:
      format: js
    blob: sha256:efae…7749
    integrity: sha256-5V6u…M9Hc
  - role: native
    selector:
      format: node
      os: linux
      arch: amd64
      libc: gnu
      abi: node-137
    blob: sha256:81c2…d04e
    integrity: sha256-Qk3v…x7Tg
  # … one native layer per tuple × ABI: twenty
  - role: common
    blob: sha256:5b90…2af1
    integrity: sha256-hN0e…pL4s
```

**`modules/starlark/telo.yaml`, a Rust controller delivered prebuilt.** Candidates are tried in order: the Node kernel takes the first `napi` candidate matching its host, the Rust kernel the first `dylib`; the existing candidates stay as the fallback. Its own `sources:` block, not shown, stages every `napi` and `dylib` path — which is why sources are keyed by path rather than hung on `native:` entries.

```yaml
kind: Telo.Definition
# …
controllers:
  - pkg:telo/local/napi?path=./native/linux-amd64-gnu/starlark.node&os=linux&arch=amd64&libc=gnu
  - pkg:telo/local/napi?path=./native/darwin-arm64/starlark.node&os=darwin&arch=arm64
  # … one napi candidate per tuple; N-API states no abi
  - pkg:telo/local/dylib?path=./native/linux-amd64-gnu/libtelorun_starlark.so&os=linux&arch=amd64&libc=gnu&abi=telo-2
  - pkg:telo/local/dylib?path=./native/darwin-arm64/libtelorun_starlark.dylib&os=darwin&arch=arm64&abi=telo-2
  # … one dylib candidate per tuple
  - pkg:npm/@telorun/starlark@0.5.0?local_path=./nodejs#script
  - pkg:cargo/telorun-starlark?local_path=./rust
```

## Decisions

- **Tolerance ships before use, as its own release.** Both failures happen while parsing a manifest during load, so no floor and no diagnostic can soften them; the only lever is which release is the last that can read the artifact.
- **`abi` is a selector axis, not part of `format`, and its value names its ABI.** It is a host property exactly as `libc` is. A bare number cannot tell Node's ABI from Bun's claim to it or from the Rust controller ABI, and a value pinned into a published artifact cannot be requalified later. It is legal on a controller candidate too — `KNOWN_QUALIFIERS` derives from the axis set — and every `dylib` candidate states it.
- **No `requires.host.node` ceiling; the missing-native-layer error is the ABI limit.** A host range restates the shipped ABIs in another vocabulary with nothing checking that the two agree, and the `requires:` gate would make the whole module unreadable, with a remedy telling the user to upgrade Node. The error fires only where the binary is needed, and names what the module ships.
- **A `native` role, not `siblings=`.** A sibling attaches to a candidate, so the matrix multiplies by kind count and duplicates the platform-neutral bundle into every layer.
- **No flattening; per-tuple paths are an invariant.** `--platform` co-locates foreign layers in the host's directory and markers carry no selector, so a shared path is a silent wrong-binary load after a warm follows a run.
- **A native file is addressed by logical name.** Neither a path placeholder (which collides with `!include-*`, where braces are glob characters) nor a host-tuple accessor (which makes every module re-compose a string it can get wrong); the kernel already knows which layer matched.
- **A missing native layer raises its own error, not `ControllerEnvMissingError`.** That class means "fall through to the next candidate", and a native layer is not a candidate — there is nothing to fall through to, so it would surface as a generic no-candidate failure and mask a packaging gap. The error names the host and the tuples the module ships.
- **The axis vocabulary becomes data with a generated TypeScript constant.** Both kernels must agree on it once part 5 exists; generating the constant from the JSON preserves the literal field types the ten current consumers rely on, following the surface-version precedent.
- **Staging is declared fetch — no build step, no hook.** Every case reduces to fetching a pinned file. Building at publish shares `node-gyp`'s toolchain and reproducibility problems (below), and a function-shaped hook is readable by the Node CLI alone. An npm platform package needs no source kind of its own: its registry tarball is an archive at a predictable URL, and a kind added later reaches only publishers, never consumers.
- **Sources sit beside `native:`, keyed by path, and publish removes them.** Not inside `native:` entries: a platform-qualified controller candidate is staged too and has no room for a source, and one version and URL serve every entry. Not in a separate file: a path written in both places would be compared only at publish, and a notice file would need a `files:` entry to reach the payload. Removed at publish because no consumer reads it, and keeping it would put a moved upstream URL with unchanged bytes into the import pin — a new version of the module and of everything importing it.
- **Rust controllers are prebuilt, not rebuilt per release.** The payload digest decides whether a module bumps, so its bytes must be fixed; a rebuild moves the digest whenever it is not bit-reproducible across runner images, bumping the module and every importer. Prebuilds are also the path a third-party author takes, so this repo exercises it.
- **A staged file may be an executable or a symlink, and the digest covers both.** The archive header pins mode `0o644` and both readers skip non-file entries, which is fine for a `.node` and wrong for a soname chain or a staged binary, so framing carries the executable bit and link entries. An `integrity` line that omitted them would let a cache revalidated from disk accept a file that lost the bit or a repointed link, so an executable's line and a link's line each say what they are; a regular file's line is unchanged, so every integrity already published still verifies. A link must name an entry of its own layer: the rule rejecting an escaping entry path says nothing about where a link points, and a target in another layer can dangle.
- **better-sqlite3, not `node:sqlite`.** The built-in would remove the binaries, the ABI coupling and the redistribution, but on Node 24 it is experimental — it warns `SQLite is an experimental feature and might change at any time` — so its API may change in a minor release.
- **`wasm` stays out** — platform-neutral, so it needs no selection machinery. **Electron ABIs stay out** — Telo does not host Electron. **No `node-gyp` fallback** — it needs a toolchain, is not reproducible, and turns a packaging gap into a compile at first run.

## Verification

Every normative delta lands in `kernel/specs/module-artifact.md` v1.1 — the §1 role table, the §1.2 and §5.1 role lists, the §2 grammar, §2.1's closed-axis sentence and the `abi` value form, the §3 field table, §3.1, §3.3's integrity line for executables and links, and §5's rule for link targets — because it is the contract the second kernel implements.

Index-parse tests assert an entry with an unknown axis or an unknown role is skipped while a malformed one still throws, and that a pre-layers single-blob artifact still yields its manifest. Partition tests assert one controller layer and twenty native layers with the declared selectors, and that a `native:` entry with no staged file fails the publish. On a tree with nothing staged, `telo release check` computes every native layer's integrity from its pins, equal to what publish computes from the staged bytes; a crate input change with no re-pin fails it. A layer of regular files digests exactly as before; a cache whose file lost its executable bit or whose link was repointed fails revalidation; a link naming anything outside its own layer is refused at publish and at extraction. Publish refuses a source with no notice file, and `telo release stage --pin` writes digests that plain `telo release stage` then verifies. `telo check` reports a source entry whose path nothing in the manifest names. The published `telo.yaml` carries no `sources:` block, a sibling's pin hashes that published text, and editing only a source's `url` moves no digest. A cross-warm test is the C1 regression: run on one tuple, warm another, run again, and assert the first tuple's file is what loads. A driver test asserts better-sqlite3 opens against an explicitly passed addon path from inside a bundle — the premise this plan rests on. On a musl host the musl layer is the one materialized; on a host matching none, the dedicated error names the host and the shipped tuples. Under Bun no `node-*` layer matches, and the Rust kernel never fetches a `dylib` layer stating another controller ABI. `telo install --platform linux/arm64/musl --abi node-141` warms exactly those layers and, without `--abi`, reports the abi-constrained layers it skipped. A Rust-authored controller loads from a published artifact with no source checkout on **both** kernels. `telo module manifest --json` reports sqlite's platforms as the ten tuples at `node-137` and `node-141`. `modules/sqlite`'s existing `requires: telo: ">=0.82.1"` is raised, keeping the file's one-comment-per-reason convention, and gains no host bound; the release plan absorbs its twenty-two ledger keys turning over at once, the forced bump, and propagation to every in-repo importer, reconciled with `telo release verify --write`.
