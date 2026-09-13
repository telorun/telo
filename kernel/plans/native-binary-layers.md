# Native binary layers — consumers

## Problem

The artifact format, both kernels and the release tooling carry platform-specific binaries: the `abi` selector axis, `native` layers from a module's `native:` block, executable and link layer entries, `sources:` with `telo release stage [--pin]`, `ctx.resolveNativeFile(name)`, the Node `napi` loader, the Rust kernel's `oci://` artifact stack and `dylib` loader, and the build-input digest (`build: { cargo, inputs }`) of a crate-built source. No module in this repository uses any of it, and no pipeline produces the binaries a module would stage:

- `sqlite` is still `pkg:npm`-delivered, because better-sqlite3 locates its addon by walking up from `__filename`, which does not exist in an ESM bundle — a bundled `SQLite.Connection` fails at creation with `ReferenceError: __filename is not defined`. `@telorun/sql` still publishes to npm only because `sqlite` depends on it.
- `starlark` and `console` deliver their Rust controllers as `pkg:cargo` alone, so they load only from a source checkout with a Rust toolchain.
- Nothing builds this repository's Rust controllers per platform, and nothing notices when an upstream publishes prebuilds for a Node ABI a module does not ship yet.

## Solution

**Sequencing.** The release carrying layer-index format tolerance — an index entry with an unknown role or an unknown selector axis skipped whole (`kernel/specs/module-artifact.md` §3.1) — is cut first and alone; call it release N. A module shipping an `abi`-bearing or `native`-bearing index is unreadable by every runtime older than N, and `requires:` cannot soften that, because the failure is a throw while parsing the manifest during load rather than a diagnostic from `analyze()`. So every module below adopts `abi`, `native:` or `sources:` no earlier than release N+1, declares `requires: telo: ">=N+1"` for runtimes at or above N, and the release notes of N+1 state the hard floor for runtimes below it.

**sqlite.** One platform-neutral `pkg:telo/local/js` candidate per kind replaces the `pkg:npm/@telorun/sqlite` candidates. A `native:` block declares better-sqlite3's addon under one name, `better-sqlite3`, for the ten tuples better-sqlite3 publishes — `linux` × `amd64` / `arm64` / `arm` at `libc` `gnu` and `musl`, `darwin` × `amd64` / `arm64`, `windows` × `amd64` / `arm64` — at `abi` `node-137` and `node-141`: twenty entries, each at a path carrying its tuple. A `sources:` block beside it names better-sqlite3's GitHub release archives once, with `upstream` per entry and the MIT notice under `notices:`; `telo release stage --pin` writes every pin. The connection controller passes the file `ctx.resolveNativeFile("better-sqlite3")` resolves to better-sqlite3 as its `nativeBinding`, instead of letting the package search for it. The Bun branch moves off the `@telorun/sqlite/sqlite-driver` subpath export — a hard build error in the bundled seam — to a computed dynamic import of `bun:sqlite`, which esbuild leaves external and only Bun resolves; the module declares no `exports.code:`. The staged paths are gitignored by the module. `sql` becomes a private `-build` package once nothing outside the repository needs it to build.

**starlark and console.** Each Rust controller gains, ahead of its `pkg:cargo` candidate, one `pkg:telo/local/napi` candidate per tuple (no `abi`, since N-API is ABI-stable) and one `pkg:telo/local/dylib` candidate per tuple stating `abi=telo-<controller ABI version>`. A `sources:` block per module names the release assets the prebuild workflow publishes, with `build: { cargo: ./rust }` so `telo release check` fails when the crate or a crate it reaches moves without a re-pin. Both modules gain their first `requires:` blocks.

**Rust prebuild workflow.** A CI workflow builds each crate-built source per tuple — the `napi` backend as a `.node` addon, the `native` backend as a cdylib — on per-OS runners, cross-compiling where a runner is not available: native `ubuntu-latest` for linux amd64 gnu, `cargo-zigbuild` for the musl, arm and arm64 linux targets, `macos-latest` for both darwin architectures, `windows-latest` for windows amd64 and arm64. It generates one notice file per crate and backend with `cargo-about` covering every crate the binary links (so each in-repo crate gains a `license` field, which `cargo-about` requires), publishes binaries and notices as assets of a GitHub release tagged `rust-<module directory>-v<crate version>`, runs `telo release stage --pin` against them, and opens the re-pin as a pull request.

**Upstream ABI scan.** A scheduled workflow reads each GitHub-release source's `url` host, lists the latest upstream release's assets, recovers each asset's `{upstream}` value by reversing the URL template, and reports the ABIs the module's entries lack. For each missing ABI it opens a pull request adding the `native:` entries and the `sources:` entries — the tuple of a new entry inferred from its sibling entries' `upstream` values — and runs `telo release stage --pin`. A new Node major is therefore a pull request awaiting review, not a report from a host that just upgraded. npm platform-package families (such as `image`'s sharp packages) have no single endpoint listing their siblings and stay out of the scan.

**Release bookkeeping.** `sqlite`'s bump turns over twenty-two ledger keys at once (twenty native layers, the controller layer, the manifest), forces a version bump and propagates to every in-repo importer; the plan is applied through `telo release apply` and reconciled with `telo release verify --write` after the publish. The module publish job already runs `telo release stage` before pushing.

`image` (an N-API addon in per-platform npm packages) and `pdf` follow the same pattern afterwards.

## Decisions

- **Adoption waits for release N+1.** Both parse failures on an older runtime happen before any diagnostic can be emitted, so the only lever is which release is the last that can read the artifact.
- **No `requires.host.node` ceiling on sqlite.** A host range restates the shipped ABIs in another vocabulary with nothing checking the two agree, and would make the whole module unreadable with a remedy telling the user to upgrade Node; `ERR_NATIVE_FILE_UNAVAILABLE` fires only where the binary is needed and names what the module ships.
- **Rust controllers are prebuilt, not rebuilt per release.** The payload digest decides whether a module bumps, so its bytes must be fixed; a rebuild moves the digest whenever it is not bit-reproducible across runner images, bumping the module and every importer.
- **better-sqlite3, not `node:sqlite`.** On Node 24 the built-in is experimental and warns `SQLite is an experimental feature and might change at any time`.
- **No `node-gyp` fallback.** It needs a toolchain, is not reproducible, and turns a packaging gap into a compile at first run.

## Verification

- A driver test opens better-sqlite3 from inside a bundle through the addon path `ctx.resolveNativeFile` returns.
- `telo module manifest --json` on `modules/sqlite` reports `runtime.native` with the ten platforms and the ABIs `node-137` and `node-141`.
- `modules/sqlite/tests/*.yaml` pass on a clean checkout after `telo release stage`; with the staged addon deleted they fail with `ERR_NATIVE_FILE_UNAVAILABLE` naming `telo release stage`, and fetch nothing.
- A Rust-authored controller from `starlark` loads from a published artifact with no source checkout on both kernels — through the `napi` candidate on Node and the `dylib` candidate under `telo-rs`.
- `telo release check` fails for `starlark` and `console` after an edit under `sdk/rust/abi` with no re-pin, and passes after the prebuild workflow's re-pin.
- Stripping `requires:` from `modules/sqlite/telo.yaml` and running the release-N CLI against it rejects the manifest; restoring it, a runtime at N reports `MODULE_REQUIRES_NEWER_RUNTIME`.
- Both workflows pass `actionlint`, and the scripts they call are unit-tested.
