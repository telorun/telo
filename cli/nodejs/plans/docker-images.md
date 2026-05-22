# Docker images: variants, versioning, CI

Strategy for building and releasing Telo's Docker images on every changesets release. Covers the core kernel images (one repo per runtime), the lambda base images (`telorun/lambda-node-managed`, `telorun/lambda-node-custom`), and the CI workflow wiring that ties Docker releases to npm releases.

## Goals

- One repo per kernel runtime — `telorun/node`, `telorun/rust`, `telorun/go`, … — so `:latest` is unambiguous inside each repo and polyglot growth doesn't muddy existing tags.
- Explicit, immutable semver tags on every release (today only `:latest`, `:nodejs`, `:sha-<short>`).
- Split the current monolithic kernel image into a lean variant and an opt-in variant with a native build toolchain. Today every user pulls the Rust toolchain (~400-600 MB) whether they need it or not.
- Add a `-slim` base-OS variant so production deployments can pick a smaller footprint. (Alpine deferred — see [Out of scope](#out-of-scope).)
- Wire Docker builds into the existing changesets release flow so semver tags only appear on actual npm releases.
- Build the documented but missing lambda base images and release them alongside their package.
- Repoint the in-tree FROM-consumer ([apps/registry/Dockerfile](../../../apps/registry/Dockerfile)) at the new `telorun/node:<exact-version>-slim` tag so the new scheme has an exercised in-tree consumer from day one. [apps/docker-runner/Dockerfile](../../../apps/docker-runner/Dockerfile) is **not** a telo-image consumer (it's a node-only orchestration service that spawns telo sibling containers; the spawned image is supplied by the client at session-start) — its base stays `node:24-slim`.

## Out of scope

- **Alpine variants.** `rust-alpine` would link controllers against musl and silently fail to load prebuilt glibc native modules — a v1-day footgun for the very class of consumers the rust toolchain exists to support. Ship debian + `-slim` only; revisit when a concrete consumer asks for alpine.
- **Multi-Function-in-one-image lambda deployments** — same out-of-scope rationale as in [modules/lambda/plans/lambda-function.md](../../../modules/lambda/plans/lambda-function.md).

## Per-runtime repos

The Telo kernel is polyglot by design ("Telo must support controllers and runtimes in any language"). Different kernel implementations are different artifacts that happen to execute the same manifests, so they live in separate Docker Hub repos:

| Repo | Kernel runtime | Status |
|---|---|---|
| `telorun/node` | Node.js kernel ([kernel/nodejs](../../../kernel/nodejs)) | Today's image, currently published as `telorun/telo` |
| `telorun/rust` | Rust-native kernel | Future ([sdk/rust/Cargo.toml](../../../sdk/rust/Cargo.toml) already has a `native` feature stub) |
| `telorun/go` | Go kernel | Hypothetical, illustrates the pattern |

`:latest` is well-defined inside each repo because the repo name pins the kernel. No hidden cross-runtime default.

Non-kernel images (`telorun/telo-runner`, `telorun/registry`, lambda bases) stay as application/deployment artifacts and don't follow the per-runtime split.

## Tag scheme

Pattern inside a kernel repo (example shown for `telorun/node`):

    telorun/node:<cli-version>[-rust-<rust-version>][-slim]

- `<cli-version>` — `@telorun/cli` package version (the linked CLI/kernel/SDK group).
- `<rust-version>` — the rustup-pinned compiler version (today `1.95.0`, from the `RUST_VERSION` ARG in [cli/nodejs/Dockerfile](../Dockerfile)). Omit segment entirely for variants without the toolchain.
- `-slim` — debian-slim base. Omit for the default debian-full base.

The `-rust-<ver>` segment denotes "Rust toolchain available for compiling native components inside the image" — independent of the kernel runtime, which the repo name already fixes.

### Example tag list — `telorun/node`

For CLI release `1.4.2` and Rust pin `1.95.0`:

| Tag | Base | Rust toolchain |
|---|---|---|
| `1.4.2` | debian | no |
| `1.4.2-slim` | debian-slim | no |
| `1.4.2-rust-1.95.0` | debian | 1.95.0 |
| `1.4.2-rust-1.95.0-slim` | debian-slim | 1.95.0 |

The version segment also accepts rolling forms: `latest` (newest release), `<major>` (newest patch in that major), `<major>.<minor>` (newest patch in that minor). They compose with the variant suffixes — `latest`, `latest-slim`, `latest-rust-1.95.0-slim`, `1.4-rust-1.95.0`, `1-slim`, and so on.

Plus dev tags on every push to main (slim variants only to keep CI cheap): `sha-<short>-slim`, `sha-<short>-rust-<rust>-slim`.

## Lambda images

Two new base images released alongside `@telorun/lambda`, named to mirror the per-runtime kernel split — `node` in the repo name flags the kernel runtime baked in, reserving the namespace for future `telorun/lambda-rust-*` images:

- `telorun/lambda-node-managed:<lambda-version>` — `FROM public.ecr.aws/lambda/nodejs:<node-major>`
- `telorun/lambda-node-custom:<lambda-version>` — `FROM public.ecr.aws/lambda/provided:al2023`

Both pre-install `@telorun/kernel`, `@telorun/sdk`, `@telorun/lambda` per the existing plan in [modules/lambda/plans/lambda-function.md](../../../modules/lambda/plans/lambda-function.md) and consumer docs in [modules/lambda/docs/deploying.md](../../../modules/lambda/docs/deploying.md). No rust-toolchain variant — Lambda's filesystem is read-only at runtime, so on-demand cargo builds can't run there.

`<lambda-version>` is the `@telorun/lambda` package version. Tying lambda images to the lambda package (not the linked CLI group) decouples lambda image cadence from CLI patches and matches the rest of `modules/lambda/`'s release surface. Lambda image rebuilds are gated on `@telorun/lambda` bumps in [Rules](#rules) below.

Tags per release: `<lambda-version>`, `<lambda-version>-node<node-major>`, `latest`.

## Rules

- **One source of truth for the Rust version.** CI reads the `RUST_VERSION` ARG from [cli/nodejs/Dockerfile](../Dockerfile) and injects it into the tag matrix — never hand-maintained twice.
- **Per-release tags are immutable.** Once `1.4.2-slim` is pushed it never gets re-tagged. Rolling tags (`slim`, `latest`, `1`, `1.4`) move; versioned tags don't.
- **Release tags only appear on actual npm releases.** Wired into the changesets flow via `workflow_call` from [.github/workflows/publish.yml](../../../.github/workflows/publish.yml). Pushes to main produce only dev (`sha-<short>-*`) tags.
- **Gate per-package images on their package bump.** Build the kernel image only if `@telorun/cli` bumped; lambda images only if `@telorun/lambda` bumped. Read `outputs.publishedPackages` from `changesets/action`. The registry and telo-runner are not npm-published packages — they're application/deployment artifacts and publish on every main push (rolling `:latest` + immutable `:sha-<short>`); a CLI release additionally triggers a registry rebuild pinned to the new CLI version.
- **Release images are multi-arch (`linux/amd64` + `linux/arm64`).** Dev images stay amd64-only. Lambda images especially need arm64 — Graviton is ~20% cheaper.
- **One Dockerfile per kernel repo, multi-target.** Four variants share one builder stage so the monorepo compiles once. Rust variants layer the toolchain on top of the lean variants.
- **Downstream FROM-consumers pin to exact-version tags.** [apps/registry/Dockerfile](../../../apps/registry/Dockerfile) currently does `FROM telorun/telo:nodejs` — repointed to `FROM telorun/node:${TELO_NODE_VERSION}-slim` in this pass, with `TELO_NODE_VERSION` defaulting to `latest` for local builds and overridden to the exact CLI release in CI. Reproducible registry rebuilds at any prior CLI release point.
