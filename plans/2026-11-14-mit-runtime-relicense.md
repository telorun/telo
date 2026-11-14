---
status: draft
priority: high
depends-on: []
packages: [kernel, analyzer, cli, packages/ide-support, packages/language-server, packages/language-host, ide/vscode, packages/debug-wire, packages/debug-ui, packages/runner-core, packages/runner-protocol, packages/release-assets, apps/local-runner, apps/studio]
refinement: not-started
---

# The runtime, CLI and editor tooling under MIT

## Problem

Everything that loads, checks or runs a manifest is under the Sustainable Use License (SUL): the kernel, the analyzer, the CLI and the editor tooling. Only the SDK, the expression engine, the standard library, docs and examples are MIT. Today `npm view @telorun/kernel license` prints `SEE LICENSE IN LICENSE`, and the licensing page tells a reader that Telo "is not open source in the strict sense". That costs adoption: corporate legal review, embedding Telo in other products, packaging, and contributors. And MIT modules run only on a restricted kernel.

The license is supposed to protect the hosted platform, Telo Cloud. But a hosted platform is built from the session server, the runners and Studio, not from the kernel an author installs. Relicensing has to follow that line, and one thing crosses it today: the MIT-bound CLI serves a runner. `telo runner` runs runner-core's whole `/v1` session server (sessions, ownership, the session store) over local processes. Under the repo's rule that nothing MIT depends on SUL code, the CLI cannot become MIT while it contains that server.

## Surface

**Added**
- `@telorun/runner-protocol`: an MIT npm package with zero dependencies, browser-safe and off the telo line. It holds the runner `/v1` wire contract: request and response shapes, error codes, the `/v1/capabilities` document including `identity`, the byte-channel frame format, the workspace path rules, and the checks a client applies to `identity.resource` and DPoP proofs.
- `@telorun/release-assets`: an MIT npm package, off the telo line. It holds the per-platform names of Telo release assets, `checksums.txt` verification, and the digest-checked download cache.
- `@telorun/local-runner`: an SUL npm package with bin `telo-local-runner`, the local-process runner that `telo runner` was.
- `telo-local-runner --telo <path>`: required, the telo executable the runner supervises. Its other options are `telo runner`'s: `--port`, `--host`, `--allow-remote`, `--allow-origin`, `--state-dir`, `-o json`.
- Release units `packages/runner-protocol`, `packages/release-assets` and `apps/local-runner`, none of them on the telo line.
- An MIT `LICENSE` (standard MIT text, `Copyright (c) 2026 CodeNet Sp. z o.o.`) in `kernel/`, `analyzer/`, `cli/`, `ide/vscode/`, `packages/ide-support/`, `packages/language-server/`, `packages/language-host/`, `packages/debug-wire/`, `packages/debug-ui/`, `packages/runner-protocol/` and `packages/release-assets/`.

**Changed**
- `license` of `@telorun/kernel`, `@telorun/analyzer`, `@telorun/cli`, `@telorun/ide-support`, `@telorun/language-server`, `@telorun/language-host`, `@telorun/debug-wire` and `@telorun/debug-ui` changes from `SEE LICENSE IN LICENSE` to `MIT`, and the `LICENSE` in each tarball is the MIT text.
- The crates `telo-kernel`, `telo-analyzer`, `telo-cli` (binary `telo`) and `telo-desktop-host` declare `license = "MIT"`.
- The `telo` release binaries, the `telo-desktop-host` binaries, the CLI's container image and the VS Code extension `telorun.telo-vscode` (Marketplace listing and `.vsix`) carry the MIT license.
- `@telorun/runner-core` takes the `/v1` wire shapes from `@telorun/runner-protocol` and no longer exports them. It stays SUL.
- `TELO_APP_CLI=1` (packaged-application spec §4 rule 5) is now set by `telo-local-runner` on each telo it starts from an executable that carries a payload. `telo runner` used to set it.
- Studio's local runner: the desktop build ships two sidecars, `telo-local-runner` and `telo`, and supervises `telo-local-runner --telo <telo>`. The local-cli adapter's one executable field names that supervised telo.
- `pnpm run check:licenses`: the MIT directory list gains every directory above.
- The licensing page (`telo.run/learn/licensing`) and the README's `## License` table: the runtime, CLI and editor tooling are MIT, and the restriction covers the runners, Studio, the authoring agent and the site.

**Removed**
- `telo runner`, and running a packaged binary as one (`TELO_APP_CLI=1 ./<app> runner`). The command is unknown, with no stub.
- The polyglot debt "`cli/rust` owes `telo runner`". The local runner is no longer part of the `telo` surface.

## Solution

**The line.** MIT covers what an author installs, links against, or sees in an editor or terminal. SUL covers what serves runner sessions, which is the hosted platform.

- **MIT:** the kernel, the analyzer, the CLI (Node and Rust, including the desktop host), the editor engine and host, the VS Code extension, the debug wire format and the debug UI the CLI serves, and the two new contract packages.
- **SUL:** runner-core (session server, lifecycle, store, identity verifier, supervisor), the docker, k8s and local runners, Studio, the authoring agent, `pages`, and everything else not listed.
- The rule that no MIT package depends on an SUL one stays, and `check:licenses` keeps enforcing it.

**`telo runner` becomes `telo-local-runner`.**

- **Before:** `telo runner --port 4600` serves a local runner whose identity is the running executable.
- **After:** `telo-local-runner --telo /usr/local/bin/telo --port 4600` serves the same `/v1` contract, state root and sessions.

What changes:
- **Identity.** The runner's identity is the `--version` output of the `--telo` executable. An application pinned to that version runs on it; any other version runs on the verified release download, as today.
- **Refusals before anything starts** (exit 2, each naming `--telo`):
  - no `--telo`;
  - a bare command name, because the executable is configuration and never a `PATH` lookup;
  - a path that is not an executable telo;
  - a telo older than `MIN_SUPERVISABLE_TELO`.
- **Contract with the telo.** The runner drives the telo the way the container runners drive a kernel image: through runner-core's argv, the debug stream and the version gate. It never loads the telo as a library.
- **Delivery.** The runner ships as an npm package and as a standalone single-file build that Studio stages as a sidecar. It is not a `telo` GitHub release asset.

**The client side of a runner is MIT.**
- `@telorun/runner-protocol` is the one definition of the `/v1` wire contract. runner-core serves it. Studio's http-runner adapter and future CLI commands that talk to a runner (sign-in, `telo run --share`, Telo Cloud deploys) speak it.
- Operator configuration stays in runner-core: the agent's `AGENT_*` settings and the backend seam.

**The verified release download is its own MIT package.** `telo package` (the carrier), the desktop-helper download and `telo-local-runner` all fetch release binaries. `@telorun/release-assets` holds the asset names per platform, the `checksums.txt` check and the cache. The cache location and every refusal stay as they are today.

**Licensing and records.**
- **Licenses.** Each relicensed directory gets its own MIT `LICENSE`. Every `package.json` and `Cargo.toml` beneath it declares MIT. Each package's `prepack` copies its own directory's `LICENSE` instead of the root one. `ide/vscode/LICENSE` is replaced. The root `LICENSE` stays SUL for everything else.
- **Earlier releases.** Versions published before this release keep the SUL; nothing re-licenses them.
- **Docs.** These are updated:
  - the README `## License` table;
  - `docs/guides/licensing.md`;
  - the licensing line in `docs/guides/vs-low-code.md`;
  - the VS Code extension README;
  - the packaged-application spec (§4 rule 5);
  - `CLAUDE.md` (Licensing, Runners, the Rust-twin debt);
  - the CLI's, runner-core's and Studio's nested guides, where the local runner's section moves to runner-core's guide and to `apps/local-runner`'s README.
- **Release.** Everything ships in one release. One `Added` fragment through `telo release add` states the license change for the telo-line units, `ide/vscode`, `packages/language-host`, `packages/debug-wire` and `packages/debug-ui`. A second `Added` fragment for `cli` describes the removal of `telo runner` and names `telo-local-runner`. `packages/runner-core`, `apps/studio` and each new unit get their own fragments.

## Decisions

- **Split by role, not by package size.** Contract and client are MIT, and the session server is SUL. MongoDB, Elastic, Redis and Grafana draw the same line. Rejected: runner-core under MIT, which would let anyone host Telo runner sessions and defeats the reason for keeping a restriction at all.
- **`telo runner` leaves the CLI entirely.** A server cannot live in an MIT binary in any form. Rejected: a plugin found at install time. Either it is a `PATH` lookup, which lets machine state decide what runs, or it is an optional import that `check:licenses` cannot see and the standalone build would inline.
- **The runner is told which telo to supervise** instead of being that telo. This is the docker CLI / dockerd split, and it keeps "the executable is configuration" true for the runner itself.
- **`@telorun/release-assets` is a package of its own.** Without it, the runner would depend on one piece of the CLI. The download is spoken across telo generations, so the package is off the line.
- **The debug packages go MIT.** The kernel emits the debug wire format and the CLI serves the debug UI, so both belong with their producer. runner-core and Studio consume them from below.
- **Earlier releases keep the SUL**, so no grant is needed and none is published. All of the relicensed code has a single author, so no contributor consent is needed.

## Verify

- `pnpm run check:licenses` passes with every directory above listed as MIT.
- `npm view` on each relicensed package, the `.vsix` and each crate reports MIT, and every published tarball's `LICENSE` is the MIT text.
- The `@telorun/cli` manifest names no `@telorun/runner-core` or `@telorun/local-runner`, and its standalone build contains no fastify, pino or ws.
- `telo runner` is an unknown command and exits 2.
- `telo-local-runner` refuses each case listed above with exit 2: no `--telo`, a bare name, a non-telo file, and a telo older than `MIN_SUPERVISABLE_TELO`.
- runner-core's existing local-backend tests pass against `telo-local-runner`.
- In Studio's desktop build, an application runs through `telo-local-runner`, both on the bundled telo and on a downloaded release. A suspended workspace resumes from the same state root after an upgrade.
- A packaged application supervised as `--telo ./orders` runs its children as the CLI, so `TELO_APP_CLI=1` reaches them.
- `@telorun/runner-protocol` and `@telorun/release-assets` have no dependencies on SUL packages, and runner-protocol imports nothing at all.
