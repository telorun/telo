---
status: done
priority: high
depends-on: []
packages: [kernel, analyzer, cli, packages/ide-support, packages/language-server, packages/language-host, ide/vscode, packages/debug-wire, packages/debug-ui, packages/runner-core, apps/host-runner, apps/studio]
refinement: not-ready
---

# The runtime, CLI and editor tooling under MIT

## Problem

Everything that loads, checks or runs a manifest is under the Sustainable Use License (SUL): the kernel, the analyzer, the CLI and the editor tooling. Only the SDK, the expression engine, the standard library, docs and examples are MIT. Today `npm view @telorun/kernel license` prints `SEE LICENSE IN LICENSE`, and the licensing page tells a reader that Telo "is not open source in the strict sense". That costs adoption: corporate legal review, embedding Telo in other products, packaging, and contributors. And MIT modules run only on a restricted kernel.

The license is supposed to protect the hosted platform, Telo Cloud. But a hosted platform is built from the session server, the runners and Studio, not from the kernel an author installs. Relicensing has to follow that line, and one thing crosses it today: the MIT-bound CLI serves a runner. `telo runner` runs runner-core's whole `/v1` session server (sessions, ownership, the session store) over local processes. Under the repo's rule that nothing MIT depends on SUL code, the CLI cannot become MIT while it contains that server.

## Constraints

None.

## Surface

**Added**
- `@telorun/host-runner`: an SUL npm package with bin `telo-host-runner`, the runner that `telo runner` was. Release unit `apps/host-runner`, off the telo line. It depends on `@telorun/cli` and bundles it.
- `telo-host-runner telo <arguments>`: the runner's bundled telo, reached as the runner re-enters itself for each session on its own version.
- `@telorun/cli/release-binary`: a subpath export of `@telorun/cli`, the verified telo release download — the platform target table, the host's target, the download into the cache, its error and the cache root.
- An MIT `LICENSE` (standard MIT text, `Copyright (c) 2026 CodeNet Sp. z o.o.`) in `kernel/`, `analyzer/`, `cli/`, `ide/vscode/`, `packages/ide-support/`, `packages/language-server/`, `packages/language-host/`, `packages/debug-wire/` and `packages/debug-ui/`.

**Changed**
- `license` of `@telorun/kernel`, `@telorun/analyzer`, `@telorun/cli`, `@telorun/ide-support`, `@telorun/language-server`, `@telorun/language-host`, `@telorun/debug-wire` and `@telorun/debug-ui` changes from `SEE LICENSE IN LICENSE` to `MIT`, and the `LICENSE` in each tarball is the MIT text.
- The crates `telo-kernel`, `telo-analyzer`, `telo-cli` (binary `telo`), `telo-desktop-host` and the kernel's test crates `napi-echo` and `napi-controller-errors` declare `license = "MIT"`.
- The `telo` release binaries, the `telo-desktop-host` binaries, the CLI's container image and the VS Code extension `telorun.telo-vscode` (Marketplace listing and `.vsix`) carry the MIT license.
- `@telorun/cli` (its `.` export) exports `main`, which runs the CLI on a given argument list; importing the package no longer runs anything.
- `telo package`'s own-carrier rule: an executable is its own carrier only when its entry is the CLI's standalone one, which starts a payload as its application — not whenever it is a single-file executable. A single-file executable that is not a carrier is refused with the reason "This executable starts a program of its own rather than a packaged application, so it is the carrier for no platform." and the remedy the carries-an-application refusal already gives.
- The runner's refusals and status lines are prefixed `telo-host-runner` instead of `telo runner`.
- Studio's desktop build ships one sidecar, `telo-host-runner-<triple>`, instead of `telo-<triple>`. The local adapter is `Local (host runner)` instead of `Local (telo CLI)`, and its `executable` field (title `telo executable` → `Host runner executable`) names the host runner, empty meaning the one bundled with Studio.
- Studio's docker runner container `telo-local-runner` → `telo-docker-runner`, and its volume `telo-local-runner-bundles` → `telo-docker-runner-bundles`, so "local runner" no longer names the docker runner beside the host runner.
- The `@telorun/host-runner` npm tarball and its single-file executable carry a `THIRD_PARTY_NOTICES` file holding the MIT license text of every MIT package they bundle.
- Packaged-application spec §4 rule 5: no `telo` re-runs its own executable as the CLI, so the clause on setting `TELO_APP_CLI=1` for a child goes; the carrier rule names the executable whose entry starts the payload.
- `pnpm run check:licenses`: the MIT directory list gains every directory above.
- The licensing page (`telo.run/learn/licensing`) and the README's `## License` table: the runtime, CLI and editor tooling are MIT, and the restriction covers the runners, Studio, the authoring agent and the site.

**Removed**
- `telo runner`, and running a packaged binary as one (`TELO_APP_CLI=1 ./<app> runner`).
- The polyglot debt "`cli/rust` owes `telo runner`". The host runner is no longer part of the `telo` surface.

## Solution

**The line.** MIT covers what an author installs, links against, or sees in an editor or terminal. SUL covers what serves runner sessions, which is the hosted platform.

- **MIT:** the kernel, the analyzer, the CLI (Node and Rust, including the desktop host), the editor engine and host, the VS Code extension, and the debug wire format and the debug UI the CLI serves.
- **SUL:** runner-core (session server, lifecycle, store, identity verifier, supervisor), the docker, k8s and host runners, Studio, the authoring agent, `pages`, and everything else not listed.
- The rule that no MIT package depends on an SUL one stays, and `check:licenses` keeps enforcing it. The SUL host runner depending on the MIT CLI is the allowed direction.

**`telo runner` becomes `telo-host-runner`.** Same `/v1` contract, state root, sessions and options — `--port` (default 8061), `--host`, `--allow-remote`, `--allow-origin` (repeatable), `--state-dir`, `--verbose` (the per-request log), `-o json` with `{ url, host, port, stateDir }`, `--help` — and an unknown option is refused with exit 2. The npm package depends on `@telorun/cli` and re-enters through its own bin script; the single-file executable bundles the CLI.

Before:

```console
$ telo runner --port 4600 --state-dir ~/.telo/runner
telo runner listening on http://127.0.0.1:4600
Applications run as pasi, from /home/pasi/.telo/runner.
$ telo runner --host 0.0.0.0
telo runner: refusing to bind 0.0.0.0. This API runs applications as pasi with no authentication, so a non-loopback bind must be asked for explicitly: pass --allow-remote.
$ echo $?
2
```

After, with the published `@telorun/host-runner` whose bundled CLI is telo 0.137.0 (a checkout's build prints `0.137.0+unreleased`):

```console
$ npm install -g @telorun/host-runner
$ telo-host-runner --port 4600 --state-dir ~/.telo/runner --allow-origin tauri://localhost
telo-host-runner listening on http://127.0.0.1:4600
Applications run as pasi, from /home/pasi/.telo/runner.
$ telo-host-runner --port 0 --state-dir ~/.telo/runner -o json
{
  "url": "http://127.0.0.1:35547",
  "host": "127.0.0.1",
  "port": 35547,
  "stateDir": "/home/pasi/.telo/runner"
}
$ telo-host-runner --host 0.0.0.0
telo-host-runner: refusing to bind 0.0.0.0. This API runs applications as pasi with no authentication, so a non-loopback bind must be asked for explicitly: pass --allow-remote.
$ echo $?
2
$ telo-host-runner telo --version
0.137.0
$ telo runner
runner  error  ENOENT: no such file or directory, stat '/home/pasi/runner'  ENOENT

1 error
$ echo $?
1
```

`telo runner` reads `runner` as a manifest path (a first positional naming no command is `telo run`'s), so it fails like any missing manifest. There is no stub.

- **One executable, both roles.** The runner starts each session on its own version by running itself as `telo-host-runner telo run --watch --inspect <manifest>`, exactly as `telo runner` re-ran its own executable. Its entry hands a leading `telo` to the CLI's `main` before the runner's server stack is loaded, so a re-entry starts as fast as a plain `telo`.
- **Identity and version.** The telo version the runner runs as itself is what `telo-host-runner telo --version` prints — the bundled telo's runtime identity, `X` or `X+unreleased`. The `/v1/capabilities` `version` field is the `@telorun/host-runner` package version, the server's own.
- **Other versions.** An application pinned to another telo version runs on the verified release download, selected by the contract's version field as today, fetched through `@telorun/cli/release-binary` with the cache location and every refusal unchanged.
- **No `TELO_APP_CLI` on the runner path.** Every telo the runner starts is either itself or a release binary, and neither carries a payload.
- **The runner owns its own output and exit statuses**; it reaches the CLI only through `main` and `@telorun/cli/release-binary`.
- **Build.** The CLI's standalone single-file build takes its outer entry as a parameter; the runner's single-file build is that build with the runner's entry, so there is one recipe. It is not a `telo` GitHub release asset.
- **Packaging through the runner.** The runner's entry declares nothing about carriers, so its single-file build is never a carrier. From a local single-file build it refuses and writes nothing:

```console
$ telo-host-runner telo package ./orders --out orders
Packaging ./orders for linux-amd64-gnu
packaging for linux-amd64-gnu would download the published telo 0.137.0 and put your application inside it — but this telo is a build of its own, not the published 0.137.0, so the result would carry that release rather than the code that packaged it, and anything you changed here would be missing from it with nothing to show for it.
This executable starts a program of its own rather than a packaged application, so it is the carrier for no
platform. Package with an installed telo release, or with this checkout's own
standalone build (pnpm --filter @telorun/cli build:standalone).
$ echo $?
1
```

  From the published npm package it downloads the verified telo 0.137.0 release as the carrier, as an npm-installed telo does:

```console
$ telo-host-runner telo package ./orders --out orders
Packaging ./orders for linux-amd64-gnu
✓  orders
   Orders 1.0.0 · telo 0.137.0 · linux-amd64-gnu
   payload 2.1 MB, executable 118.4 MB
```

- **Studio.** The desktop shell stages and supervises `telo-host-runner-<triple>`; in development, with no sidecar staged, it runs the runner's bin script under `node`, which re-enters itself the same way. The local adapter's settings, before and after:

  | | Before | After |
  |---|---|---|
  | Adapter | `Local (telo CLI)` | `Local (host runner)` |
  | Field `executable` title | `telo executable` | `Host runner executable` |
  | Field description | Leave empty to use the `telo` bundled with Telo Studio, which is the version this editor was built against. Set a path to run your own build instead. | Leave empty to use the host runner bundled with Telo Studio, which is the version this editor was built against. Set a path to run your own build of it instead. |

  The docker runner's container becomes `telo-docker-runner` and its volume `telo-docker-runner-bundles`. When the shell starts the docker runner and finds a container still named `telo-local-runner` from an earlier Studio, it stops and removes it first, since that container holds the runner's port; the old volume is left alone, and the bundles it cached are fetched again.
- **Notices.** The host runner redistributes MIT code (the CLI, the kernel, the analyzer and the rest of its closure), and MIT requires the notice to travel with it. Its build writes `THIRD_PARTY_NOTICES` — each bundled MIT package's name and its `LICENSE` text — into the npm tarball beside the runner's own SUL `LICENSE`, and embeds the same file in the single-file executable.

**Licensing and records.**
- **Licenses.** Each relicensed directory gets its own MIT `LICENSE`. Every `package.json` and `Cargo.toml` beneath it declares MIT. Each package's `prepack` copies its own directory's `LICENSE` instead of the root one. `ide/vscode/LICENSE` is replaced. The root `LICENSE` stays SUL for everything else.
- **Docs.** The README `## License` table, `docs/guides/licensing.md`, the licensing line in `docs/guides/vs-low-code.md`, the VS Code extension README, `docs/guides/packaging-an-app.md` (the carrier), the packaged-application spec (§4 rule 5 and the carrier rule), `CLAUDE.md` (Licensing, Runners — "host runner" for the local-process backend — and the Rust-twin debt), the CLI's guide (its `telo runner` section and the self-spawn `TELO_APP_CLI` text go, the `telo package` carrier paragraph changes), runner-core's and Studio's guides, and `apps/host-runner`'s README, which takes the runner's section. Every other published mention of `telo runner` names `telo-host-runner`: `cli/README.md` (its `### telo runner` section and the exit-status-2 list), `docs/reference/environment-variables.md`, `apps/docker-runner/README.md` and `packages/runner-core/README.md`. The runner's tests move with its code.
- **Release.** Everything ships in one release. One `Added` fragment through `telo release add` states the license change for the telo-line units, `ide/vscode`, `packages/language-host`, `packages/debug-wire` and `packages/debug-ui`. A second `Added` fragment for `cli` describes the removal of `telo runner`, names `telo-host-runner`, and states the carrier rule and the `main` export. `packages/runner-core`, `apps/studio` and `apps/host-runner` get their own fragments. The new unit starts at a 0.x version.

## Decisions

- **Split by role, not by package size.** The session server is SUL; what an author installs is MIT. Rejected: runner-core under MIT, which would let anyone host Telo runner sessions from Telo's own code and defeats the reason for keeping a restriction at all.
- **`telo runner` leaves the CLI entirely.** A server cannot live in an MIT binary in any form. Rejected: a plugin found at install time. Either it is a `PATH` lookup, which lets machine state decide what runs, or it is an optional import that `check:licenses` cannot see and the standalone build would inline.
- **The runner is a multi-call binary that bundles its telo.** The runner and its own telo ship and version together, and which telo a session runs on already has one selector, the contract's version field. Rejected: a runner told which telo to supervise (`--telo <path>`), which adds a second selector for the same thing, an identity probe, refusals, a separate download package and a second signed ~100 MB sidecar in Studio, and cannot express the `node`-script dev fallback on Windows. It gives up running a telo that is neither the bundled build nor a published release without building the runner from that checkout; a path option could be added later without breaking anything.
- **A carrier is declared by its entry.** Only the entry that starts a payload as the application can say the executable is a carrier; inferring it from "single-file executable" makes every build that bundles the CLI a carrier that starts the wrong program. Rejected: a "not a carrier" flag on the runner's build, which every later bundler would have to remember; refusing `package` in the runner, which tracks the CLI's command table and leaves the cause in place; making the runner a valid carrier, which would ship the SUL runner inside every packaged app.
- **The release download stays in the CLI** as a subpath export, not a package of its own: its only new consumer is the runner, which already bundles the CLI.
- **No runner wire-contract package.** Studio mirrors the `/v1` types itself and nothing MIT speaks to a runner yet; runner-core keeps exporting its shapes.
- **The debug packages go MIT.** The kernel emits the debug wire format and the CLI serves the debug UI, so both belong with their producer. runner-core and Studio consume them from below.
- **Earlier releases keep the SUL**, so no grant is needed and none is published. All of the relicensed code has a single author, so no contributor consent is needed.

## Verify

- `pnpm run check:licenses` passes with every directory above listed as MIT, the two kernel test crates included.
- `npm view` on each relicensed package, the `.vsix` and each crate reports MIT, and every published tarball's `LICENSE` is the MIT text.
- The `@telorun/cli` manifest names no `@telorun/runner-core` or `@telorun/host-runner`, and the standalone build's esbuild metafile lists no input from `fastify`, `pino`, `ws` or `@telorun/runner-core`.
- Importing `@telorun/cli` runs nothing; `main(["--version"])` prints the version.
- `telo runner` fails as a missing manifest `runner`, with exit 1.
- `telo-host-runner telo --version` prints the version `/v1/capabilities` reports as its identity.
- runner-core's existing local-backend tests pass against `telo-host-runner`, both on its own version and on a downloaded release.
- No process the runner spawns has `TELO_APP_CLI` in its environment.
- From the runner's single-file build, `telo-host-runner telo package ./orders --out orders` exits 1, writes no file, and its remedy sentence is byte-identical to the one a packaged application gives under `TELO_APP_CLI=1 ./<app> package …` from a local build; the CLI's own standalone build still packages for the host offline.
- A re-entry (`telo-host-runner telo --version`) loads none of fastify, pino or ws.
- No published doc outside the changelogs names `telo runner`.
- The `@telorun/host-runner` tarball holds `THIRD_PARTY_NOTICES` naming every MIT package in its bundle's esbuild metafile, each with its license text, and the single-file executable carries the same file.
- Studio starts the docker runner as `telo-docker-runner` on a machine where a `telo-local-runner` container from an earlier Studio is running, and no `telo-local-runner` container remains afterwards.
- Studio's local adapter settings show `Local (host runner)` and `Host runner executable`, and no string there says `telo executable` or `telo CLI`.
- Studio's desktop bundle holds exactly one sidecar, an application runs through it on the bundled telo and on a downloaded release, and a suspended workspace resumes from the same state root after an upgrade.
- A Windows development build of Studio runs an application with no staged sidecar.
