# Native binary layers — consumers

## Problem

The artifact format, both kernels and the release tooling carry platform-specific binaries: the `abi` selector axis, `native` layers from a module's `native:` block, executable and link layer entries, `sources:` with `telo release stage [--pin]`, `ctx.resolveNativeFile(name)`, the Node `napi` loader, the Rust kernel's `oci://` artifact stack and `dylib` loader, and the build-input digest (`build: { cargo, inputs }`) of a crate-built source. Only `sqlite` uses any of it — better-sqlite3's upstream prebuilds, staged through `native:` and `sources:` — and no pipeline produces the binaries a module would stage:

- `starlark` and `console` deliver their Rust controllers as `pkg:cargo` alone, so they load only from a source checkout with a Rust toolchain.
- Nothing builds this repository's Rust controllers per platform, and nothing notices when an upstream publishes prebuilds for a Node ABI a module does not ship yet.

## Solution

**Sequencing.** The release carrying layer-index format tolerance — an index entry with an unknown role or an unknown selector axis skipped whole (`kernel/specs/module-artifact.md` §3.1) — is cut first and alone; call it release N. A module shipping an `abi`-bearing or `native`-bearing index is unreadable by every runtime older than N, and `requires:` cannot soften that, because the failure is a throw while parsing the manifest during load rather than a diagnostic from `analyze()`. So every module below adopts `abi`, `native:` or `sources:` no earlier than release N+1, declares `requires: telo: ">=N+1"` for runtimes at or above N, and the release notes of N+1 state the hard floor for runtimes below it.

**starlark and console.** Each Rust controller gains, ahead of its `pkg:cargo` candidate, one `pkg:telo/local/napi` candidate per tuple (no `abi`, since N-API is ABI-stable) and one `pkg:telo/local/dylib` candidate per tuple stating `abi=telo-<controller ABI version>`. A `sources:` block per module names the release assets the prebuild workflow publishes, with `build: { cargo: ./rust }` so `telo release check` fails when the crate or a crate it reaches moves without a re-pin. Both modules gain their first `requires:` blocks.

**Rust prebuild workflow.** A CI workflow builds each crate-built source per tuple — the `napi` backend as a `.node` addon, the `native` backend as a cdylib — on per-OS runners, cross-compiling where a runner is not available: native `ubuntu-latest` for linux amd64 gnu, `cargo-zigbuild` for the musl, arm and arm64 linux targets, `macos-latest` for both darwin architectures, `windows-latest` for windows amd64 and arm64. It generates one notice file per crate and backend with `cargo-about` covering every crate the binary links (so each in-repo crate gains a `license` field, which `cargo-about` requires), publishes binaries and notices as assets of a GitHub release tagged `rust-<module directory>-v<crate version>`, runs `telo release stage --pin` against them, and opens the re-pin as a pull request.

**Upstream ABI scan.** A scheduled workflow reads each GitHub-release source's `url` host, lists the latest upstream release's assets, recovers each asset's `{upstream}` value by reversing the URL template, and reports the ABIs the module's entries lack. For each missing ABI it opens a pull request adding the `native:` entries and the `sources:` entries — the tuple of a new entry inferred from its sibling entries' `upstream` values — and runs `telo release stage --pin`. A new Node major is therefore a pull request awaiting review, not a report from a host that just upgraded. npm platform-package families (such as `image`'s sharp packages) have no single endpoint listing their siblings and stay out of the scan.

`image` (an N-API addon in per-platform npm packages) and `pdf` follow the same pattern afterwards.

## Decisions

- **Adoption waits for release N+1.** Both parse failures on an older runtime happen before any diagnostic can be emitted, so the only lever is which release is the last that can read the artifact.
- **Rust controllers are prebuilt, not rebuilt per release.** The payload digest decides whether a module bumps, so its bytes must be fixed; a rebuild moves the digest whenever it is not bit-reproducible across runner images, bumping the module and every importer.

## Verification

- A Rust-authored controller from `starlark` loads from a published artifact with no source checkout on both kernels — through the `napi` candidate on Node and the `dylib` candidate under `telo-rs`.
- `telo release check` fails for `starlark` and `console` after an edit under `sdk/rust/abi` with no re-pin, and passes after the prebuild workflow's re-pin.
- Both workflows pass `actionlint`, and the scripts they call are unit-tested.
