# Standalone `telo` binary

One executable per platform that runs manifests on a machine with no Node.js installed, released
the way Studio's desktop builds are. The binary is Node's own single-executable format: the CLI
bundled to one file, injected into an official Node 24 runtime, with the platform's esbuild
executable carried as an embedded asset.

Measured on linux-amd64-gnu (Node 24.11.1, Node absent from `PATH`): `telo check` passes, a
manifest importing the published `console@0.17.4` runs and exits 0, and in a `debian:trixie-slim`
container that has never had Node.js the `.deb` installs and `telo --version` answers. The binary is
129 MB, almost all of it the Node runtime; 47 MB as a `.tar.gz`, 36 MB as a `.deb`.

What holds elsewhere, and is unverified: the macOS, Windows and musl builds, `--watch`, `telo test`,
and the inspect UI have not been exercised from a binary. Node documents single-executable support
as experimental; every probe here behaved.

Scope boundaries this plan takes as settled: the binary ships no package manager, so only bundled
controllers run in it; the
`@telorun/cli` npm package and the `telorun/node` images keep shipping unchanged; the maintainer
release commands (`telo release`, `telo publish`) still shell out to `git`, `npm` and `npx`, and
simply fail when those are absent.

## 1. One SDK realm mechanism, on every runtime

**Before.** A controller bundle imports `@telorun/sdk` as a bare specifier, and the kernel makes
that resolve by symlinking `node_modules/@telorun/sdk` beside the extracted bundle, pointing at its
own copy on disk. The npm install root under `.telo/npm/` supplies the same copy as a `file:`
dependency. Inside a binary there is no copy on disk, so every bundled controller fails with
`ERR_MODULE_NOT_FOUND` — reproduced.

**After.** The kernel publishes the SDK it has loaded to the running process, and writes a
generated `node_modules/@telorun/sdk/` beside the bundle — a `package.json` plus a module that
re-exports that instance. It is written in the same extract phase that writes the link today, so a
read-only mount still works, and it is regenerated whenever its contents do not match the running
kernel, which is what keeps a directory shared between kernel versions correct. Importing it with
no host kernel present throws an error naming the cause rather than resolving to an empty module.

**The npm install root keeps its `file:` dependency and is untouched by this.** That directory is
reconciled by a package manager, which prunes what it did not install and — pnpm by default —
installs a missing peer from the registry, and every npm-delivered module declares the SDK as a
peer. A generated package placed there would be removed or shadowed by a registry copy, which is
two SDK instances in one process: precisely the identity failure the realm exists to prevent.
There is nothing to unify anyway, since an install root only exists where a package manager does,
and the binary never builds one.

Everywhere the kernel itself owns the directory, this one mechanism replaces the symlink. A Node
module hook would be the smaller change on Node, but Bun has no `registerHooks` (verified on Bun
1.3.14, which the repo's own `pnpm run telo` and `pnpm run test` use), so a hook means two
mechanisms and a broken test suite.

**Verify.** One manifest importing a published bundled module runs under Node, under Bun, and from
the binary. No symlink exists under the bundle directory. A generated package left by a different
kernel version is replaced rather than reused. Measured on all three runtimes already, with 138
re-exported names and `instanceof` identity preserved across the boundary. Separately, a manifest
importing an npm-delivered module still runs under the Node-installed CLI, and a repeat install in
an existing install root leaves exactly one SDK copy in that tree.

## 2. The compiled validator cache

**Before.** Cached validators load ajv runtime modules from disk. From a binary every load fails,
and the failure is a `validator cache load failed` warning that nothing acts on, so the cache
silently never hits and every validator is recompiled on every run — observed three times in one
run. A warning on a hot path is indistinguishable from noise, which is why a cache that never hit
went unnoticed rather than being caught by the run that introduced it.

**After.** Those runtime modules come from the same realm table as the SDK, but in-process rather
than through a generated package: the kernel evaluates a cached validator with a `require` of its
own, so it hands the helpers over directly and writes nothing to disk. And the two outcomes stop
being one outcome: a cached file whose integrity header
does not match is an ordinary miss and stays silent, because rewriting it is the designed recovery,
while a file that fails to LOAD is reported as a diagnostic naming the cache path and the reason.
The second class means the cache is unusable in this environment, and nothing but a report can say
so.

**Verify.** Run a manifest twice from the binary: the second run logs no `validator cache load
failed` and compiles nothing. Corrupt a cached validator's body and the run reports a diagnostic
rather than a warning; change its integrity header and the run is silent.

## 3. Version stamps fixed at build time

**Before.** The kernel version, the ajv and ajv-formats versions, and the `@telorun/debug-ui`
version are read from `package.json` files at runtime, each falling back to `unknown`. In a binary
there are no such files, so all of them read `unknown` — and those values are cache keys, so cached
analysis and cached validators would survive an upgrade that should invalidate them.

**After.** All four are fixed when the binary is built, so the binary never asks. That removes the
symptom on one distribution; the fallback itself is what made the symptom silent, so it goes too:
**an undeterminable key input is never used as a key.** When a version cannot be determined the
cache is neither read nor written for that entry, and the reason is reported once. The entry misses
loudly instead of hitting wrongly, on every distribution and in any future environment that cannot
read a `package.json`.

Baking every distribution's stamps instead was the alternative and does not close it: a source
checkout run through Bun has no build step to bake into, so the runtime read stays a real path and
needs a sound answer for the case where it fails.

**Verify.** Inspect the stamps a binary writes under `.telo/analysis/`: none reads `unknown`. A
binary built from a later version does not reuse the earlier version's cached analysis. With a
version made undeterminable by hand, a run reports it and writes no cache entry, rather than
writing one keyed on `unknown`.

## 4. esbuild inside the binary

**Before.** esbuild is an optional npm dependency, used to build controllers from a source checkout
and by the publish path; when it is missing the kernel falls through.

**After.** The binary carries the esbuild executable for its own platform and unpacks it once into
`.telo/tools/` (honouring `TELO_CACHE_DIR`) on first use, at the version the bundle expects. Only
the asynchronous esbuild API is used: the synchronous one hangs inside a binary, because it starts
a worker from the executable's own path. The kernel already uses the asynchronous API — this is a
constraint to keep, not a change to make.

**Verify.** From a source checkout with esbuild not installed anywhere, a manifest importing a
module by relative path runs from the binary. Both the native-addon load path and an embedded
esbuild compile were measured working inside a binary.

## 5. A missing package manager is reported, not guessed at

**Before.** A `pkg:npm` controller candidate is installed into `.telo/npm/` by shelling out to the
package manager named by `TELO_PKG_MANAGER` (default `npm`). When that binary is not on `PATH` the
spawn failure surfaces as whatever the operating system said.

**After.** The failure names the module, the kind, and the package manager that was looked for,
says the controller is delivered from npm so that manager is required, and says how to supply one
— install Node.js, which carries `npm`, or point `TELO_PKG_MANAGER` at a manager that is on `PATH`.
This is runtime-neutral: a binary has no package manager, but neither does a container or a
stripped-down host, and all three get the same error. `image` and `starlark` stay npm-delivered and
so need one wherever they run; `pdf` stops being one (§6).

**Nothing probes for the tool first.** The error is built by recognising the spawn's own
"not found" failure and replacing it, so a machine that has the tool pays nothing. A pre-flight
check would spend a process launch on every boot to answer a question that only matters on the
path that is about to ask it anyway. The same rule covers `git` and `npx` in the release and
publish commands: no probe, and the launch failure becomes a message naming the tool and how to
install it, instead of a bare `ENOENT`.

**`telo check` may probe; boot may not.** Check is allowed the process launches, so it reports a
missing tool before a deployment meets it. What the two halves share is the rule and the wording —
which controller candidate needs which tool (an npm-delivered one needs the package manager, a
crate-built one needs `cargo` and `rustc`) and what the message says. That table lives in the
kernel, which is the only place both halves can reach: the analyzer must stay runnable in a
browser, so it can spawn nothing, and the kernel cannot import the CLI. The probe is check's alone.

It is a **warning, not an error**: the machine running `telo check` is frequently not the machine
that will run the app, so a missing tool here says nothing about whether the manifest is right.
For the same reason this refusal has no place in the check-versus-run agreement suite — the two
halves are deliberately answering different questions. Check probes only the tools the manifest's
own import closure actually calls for, once per tool per run, so a manifest with no such controller
spawns nothing.

**Verify.** With no `npm` on `PATH`, a manifest importing `image` or `starlark` fails with that
error and leaves no partial `.telo/npm/` tree — under the Node-installed CLI and from the binary
alike. The same manifest under `telo check` warns, naming the tool and how to install it, and still
exits 0. A manifest that needs no npm-delivered controller launches no process at either check or
boot, which a trace of spawned processes shows.

## 6. `pdf` moves to bundled delivery

**Before.** Its three kinds are delivered from the published `@telorun/pdf` npm package, so they
need a package manager at load.

**After.** One bundled controller in the module's own artifact, like the rest of the standard
library. `pdf-lib`, `pdfjs-dist` and the `@napi-rs/canvas` wrapper inline into the bundle. Four
things cannot, each because it is resolved beside a package the bundle is not, and each relocated
through the option its owner already provides:

| What | Where it ships | How it is named |
| --- | --- | --- |
| Skia, per platform | a `native:` entry, one per tuple | `NAPI_RS_NATIVE_LIBRARY_PATH` |
| standard fonts, CMaps, wasm decoders | module assets | `standardFontDataUrl` / `cMapUrl` / `wasmUrl` |
| pdf.js's worker | a module asset | `GlobalWorkerOptions.workerSrc` |
| `DOMMatrix`, `ImageData`, `Path2D` | — | set as globals from the loaded canvas, before pdf.js is imported |

Platforms: darwin x64/arm64, linux x64 and arm64 in gnu and musl, windows x64/arm64 — every tuple
the upstream package publishes, and every one the binary targets. Skia's addon is `format: napi`
with no `abi`, since N-API is ABI-stable.

The module declares `requires: telo: ">=0.91.0"`, its package becomes the private
`@telorun/pdf-build`, and it carries a module changelog fragment rather than a changeset.

**Verify.** `modules/pdf/tests/*.yaml` pass from a checkout, `telo check` reports no `NATIVE_*` or
`SOURCE_*` code, and the floor is verified by execution against the previous published CLI in both
directions.

## 7. The build, in `cli/nodejs`

Produces `telo` (`telo.exe` on Windows) per target: the CLI bundled to a single file with the §3
stamps baked in, injected into the official Node 24 runtime for that target together with the
platform's esbuild asset.

Targets, all of which have official Node 24 builds: linux x64 glibc, linux x64 musl, linux arm64
glibc, darwin x64, darwin arm64, win32 x64, win32 arm64. There is no official linux arm64 musl
runtime, so that target does not exist; ppc64le and s390x are available if wanted later.

macOS builds have their signature stripped before injection and are ad-hoc re-signed after. Like
Studio's desktop builds, nothing is signed with a developer identity, so Gatekeeper and SmartScreen
warn on first launch.

**Verify.** On each target, with Node absent from `PATH`: `telo --version` reports the CLI version,
`telo check` passes on a manifest importing a published module, and that manifest runs.

## 8. Release and installers

Triggered by `@telorun/cli`'s version moving on `main` — the same signal the kernel image build
uses — plus manual dispatch for a rebuild of the current version.

**The binaries are assets of the product's release, not a release of their own.** A `v<version>`
release already exists on that signal and already carries the changelog; a second one for the same
version of the same product would split it across two pages. So the standalone workflow attaches to
`v<version>` and sets neither name nor body. Both fire on one commit and either may arrive first,
so the release script fills a body it finds empty instead of treating an existing release as
"nothing to do" — otherwise which job won the race decided whether the release ever got a changelog.

**That release is created as a DRAFT and published only once the installers are attached and
verified.** A published `v<version>` carrying no installers is one nobody can install from. The
install scripts read `releases/latest`, which skips drafts, so a failed build leaves the previous
release standing and shows the failure as a stuck draft rather than as an empty release page.

**Asset names use Telo's own platform vocabulary** — `telo-<version>-linux-amd64-gnu.tar.gz`,
`…-windows-arm64.zip` — the tokens a `native:` entry, a platform-qualified controller PURL and
`telo install --platform` already use. Native installers keep their own format's spelling
(`telo_<v>_amd64.deb`, `telo-<v>-1.x86_64.rpm`), because that is the package manager's namespace and
a `.deb` whose filename disagrees with its `Architecture:` is a broken package. Each Windows
installer is named per target: one name for two architectures is an upload collision in which the
second job silently replaces the first.

**The advertised command is `curl -fsSL https://telo.sh/install.sh | sh`** (`irm
https://telo.sh/install.ps1 | iex` on Windows), served as a redirect to the scripts at a release
tag. The scripts live at the repository root — they install the product, not `cli/nodejs` — and the
site copies them into its static files at build, so there is one source of truth and
`telo.run/install.sh` keeps resolving. A `raw.githubusercontent.com` URL is never advertised: it
pins the product's most permanent line to a git host, an organisation, a repository name and a
branch.

**The implementation language appears in no tag, asset name or install command.** `cli/rust` builds
a binary called `telo` at the same version, and is not published while it hosts fewer controller
formats than this one — 185 standard-library kinds ship as JS bundles, which only the Node kernel
opens. A build that cannot host everything this one hosts is named for that restriction, never for
the language: which kernel can host a kind is derived from its `controllers:` PURLs, so it is not a
question to hand a user at download time. The day a Rust-built `telo` ships, no tag, no asset name
and no install command changes — only the bytes behind them.

Upgrades happen by reinstalling; there is no self-update command, and `telo upgrade` remains what it
is — a rewriter of `imports:` pins.

**Verify.** Each installer puts `telo` on `PATH`, `telo --version` matches the release tag, and a
manifest importing a published module runs. The Linux half is checked in containers that have no
Node.js at all — a Debian slim image for the `.deb`, an RPM-based image for the `.rpm`, and an
Alpine image for the musl archive — which is the only place "no Node.js installed" is a fact rather
than an assumption. macOS and Windows have no such image, so they are checked on release runners
with the runner's Node directory removed from `PATH`. Every platform token in every published asset
name is one `telo install --platform` accepts.
