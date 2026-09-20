# Distributing an application as one executable

`telo package ./telo.yaml --platform linux/amd64/gnu --out dist/orders` produces a single file that
runs that application on a machine with no Node.js, no network and no telo installed. The file is
the released `telo` binary for that platform with the application's payload carried inside it: the
manifest, every local file its graph reaches, and the whole resolved import closure — imported
manifests, controller bundles, native files and module assets — warmed for that platform.

Nothing new is invented for the payload. `telo install --platform <os/arch[/libc]> --abi <family-n>`
already produces that tree, and `TELO_CACHE_DIR` already relocates it, which is how the prebuilt
kernel images boot hermetically today. What is missing is a command that joins the tree to a carrier
and a startup path that unpacks it — and the four rules in §1 that turn a *best-effort* cache into a
*complete*, *relocatable* one, because a packaged app has no lazy path to fall back on and does not
run where it was built.

Measured on linux-amd64-gnu: the carrier is 140,774,592 bytes, and appending 5 MB of trailing bytes
to it leaves `telo --version` answering. Every packaged app inherits that size.

## 1. The payload

**Before.** An app is distributed as a manifest plus instructions: install telo, run `telo install`,
hope the registry is reachable. Three moving parts, one of which is the network.

**After.** One gzipped tar carried inside the executable, holding:

- `telo-app.json` — format version, the application's `metadata.name` and `metadata.version`, the
  entry manifest's path inside the payload, the platform and abi, and the telo version that
  built it.
- `app/` — the entry manifest and every local file the graph reaches: `include:` partials, local
  imports, `!include-text` / `!include-bytes` files, module assets, and — per §1.2 — every local
  module's **built** controller and library entry points and its staged files. Controller *sources*
  are deliberately absent.
- `cache/` — the warmed cache tree: cached manifests for every import, the materialized module
  layers for the platform (controller, library, native, assets, common), the compiled validators and
  the analysis stamp.

**The closure is computed, never "the project directory".** A packaged binary is extractable by
anyone holding it, so nothing joins the payload that the manifest graph does not name. `.env` and
`.env.local` are excluded by rule, not by accident: they are configuration, they frequently hold
secrets, and §4 reads them from the deployment instead.

Layer framing is already a pure function of the files, so the same manifest and closure produce the
same payload bytes and the same digest — which is what makes the unpack cache in §4 hit across
rebuilds that changed nothing.

**Packaging fails on analysis errors**, with the diagnostics `telo check` would print. A binary that
cannot boot is worse than a refusal, and the warm pass already runs the analysis.

### 1.1 An unwarmed layer becomes a failure, in `telo install` itself

**Before.** The warm pass is best-effort by design: a transient fetch failure is reported and
skipped, and so is a layer constraining an axis the named platform leaves undetermined — `run` fetches
lazily, so a miss costs a round trip. Only an integrity failure, a malformed layer index and a tar
entry escaping the module directory are fatal. That is sound while a lazy path exists. It is not
sound for a baked image, and it is not sound at all for a payload: there, the warmed tree is the
*only* cache, the network is off by assumption, and a skipped layer is a binary that cannot boot —
reported at build time as a warning nobody read.

**After.** `telo install` exits non-zero when any layer the named platform needs was not materialized,
naming the module, the layer's role and its selector. The two skip classes become the two halves of
that refusal: a fetch that failed says so and is retryable, while a layer skipped for an undetermined
axis names the flag that determines it (`--abi`, or the `libc` of `--platform`). This is a
behaviour change for an image build that passes no `--abi` and today gets a warning — it now gets a
refusal naming the flag, which is the same failure moved from first boot to build time, where it can
be fixed. `telo package` inherits the rule rather than restating it: one posture for "the cache must
be complete", the same one §1 already takes for analysis errors.

### 1.2 A local module is carried built, never as source

**Before.** Warming materializes layers, and only a module that HAS an artifact has layers — so a
module reached by a relative `source:`, including the application's own `Telo.Definition`s, is
skipped by it entirely. Its controller is built from the `local_path` TypeScript at load, by the
kernel's dev branch, and so is every `exports.code:` library entry point a sibling bundle imports.
Three things follow that the payload cannot live with: the first run of such an app **compiles
TypeScript on the target machine**, which is the opposite of "the warmed tree is the only cache";
the file set that build reaches is discovered by the bundler, not by the manifest graph, so an
inventory drawn from the graph would ship an incomplete source tree; and `--platform` says nothing
about that half of the closure.

**After.** Packaging brings every local module in the closure to the state a built, staged working
copy is in: each `pkg:telo/local/js` candidate's `path=` file and each `exports.code:` entry point
are built through the same builder `telo publish` and `telo release` already share, and every
`sources:` entry is staged for the named platform, the sequence `telo release stage` already runs.
The TypeScript sources then stay out of the payload — and their absence is what makes the property
self-enforcing rather than declared: the kernel's dev branch fires only when a `local_path` source
is on disk, so with none there, the prebuilt file at `path=` is what loads. That branch is not a
new delivery invented for packaging; it is the one a working copy that has run its build already
takes.

**Not by minting artifacts for local modules**, which was the alternative: a layered artifact is
addressed by a pinned ref and verified against it, and a module no registry holds has neither, so
the payload would carry artifact-shaped things nothing can re-verify — losing the one property
layer addressing exists for, in exchange for uniformity of shape.

A consequence worth stating: a packaged app never runs esbuild, so the embedded compiler is never
unpacked, and the source-bundle cache — whose index is keyed by the source file's absolute path —
is never consulted, which is one relocation hazard removed rather than fixed.

### 1.3 Portability is derived from the carrier, not listed here

**Before.** Which layers are warmed is `--platform`'s question; where npm packages and cargo builds
land is the *host's*, deliberately — an install materializes them for the machine it runs on. So a
closure holding an npm-delivered or crate-built controller is materialized for the packaging
machine, and `--platform linux/arm64` would ship an amd64 tree inside an arm64 binary. Worse, when
the packaging CLI is itself the standalone binary — the preferred host path in §2 — it has no
package manager, so such a controller cannot be materialized even for the host, and the packaged app
fails at first boot with the kernel's "install a package manager" message inside a binary that
structurally cannot have one.

**After.** A candidate may be packaged when **two predicates hold**, both read off tables that
already exist rather than restated as a list here:

- **the carrier's kernel hosts the candidate's format** — the same derivation that already answers
  which kernels can host a kind, from its `controllers:` PURLs; and
- **the candidate needs no external program on the target machine** — the same table that already
  says which candidate needs which tool (`pkg:npm` the package manager, `pkg:cargo` cargo).

A kind whose every candidate fails is refused, naming the kind, the candidate, the module that
declares it and **which predicate failed**, and saying the application still runs under an installed
telo. It is read per candidate, not per module, so an application's **own** `Telo.Definition`
declaring a crate-built controller is refused by the same predicate as an imported one — a case
worth naming because §1.2 carries local modules built, and a reader could take that to mean a local
kind is portable whatever it declares. Today the rule refuses the two deferred npm-delivered modules
(`image`, `starlark`) and crate-built controllers, and passes the rest of the standard library — but nothing here says so as a rule, which
is the point: the day `cli/rust` becomes a carrier, the same closure gets the opposite verdict on the
first predicate with no edit to this plan, and a new format or loader moves one table rather than
three.

**Verify.** Package an application importing a published module and one shipping a native file;
`telo package inspect` (§3) reports the native layer of the named platform and no other. With the
registry unreachable, packaging fails naming the module and layer rather than producing a file.
`telo install` over a closure holding an abi-constrained layer, with no `--abi`, exits non-zero
naming that flag — where packaging the same closure succeeds, because a carrier determines the abi
and `telo package` never asks for one. Package an application importing `image` and confirm the
refusal names the kind, the npm candidate and the tool predicate. Package an application whose own
`Telo.Definition` is built from local TypeScript: the payload holds its `path=` bundle and no `.ts`
file, and running it unpacks no esbuild into the app's tree. Package an application beside a `.env`
holding a secret and confirm the string does not occur in the output file. Package twice with no
edits and confirm both files are byte-identical.

### 1.4 The warmed verdict has to survive relocation

**Before.** The analysis stamp is filed under a hash of the **entry URL** and its signature hashes
each reachable file's **source URL** — absolute `file://` paths on the packaging machine. Unpacking
under `<cache root>/apps/<name>-<digest>/` changes both, so the stamp is a permanent miss: every
start of every packaged app re-runs the full validation walk, and nothing reports it, because a miss
is the designed silent recovery. Nobody has met this yet because the baked-image flow copies the
tree to the path it was built at. The Verify list this plan had would not have caught it either —
"the second start unpacks nothing" passes with a permanently cold analysis cache.

**After.** Inside a packaged app the stamp is keyed and signed by the **payload digest**. The
payload is immutable and its digest already identifies exactly the file set the stamp is a verdict
about, so this is stronger than the path-based signature rather than a weaker stand-in for it: there
is no file to have changed since. It is deliberately not a general fix for relocating a `.telo`
tree — a mutable checkout still needs per-file identity — and it is confined to the packaged path
for that reason.

**Verify.** A packaged app hits the stamp on its **first** start, not merely its second: the
payload carries a warmed verdict, so a first run that re-validates means the key did not survive.
Measured as the absence of the validation walk, with the two starts' times reported beside each
other.

## 2. The carrier

**The carrier is the released `telo` binary for the platform, at this CLI's own version.** When the
packaging process is itself a standalone binary and the platform is the host's, its own executable
is the carrier; otherwise the release asset for that platform is fetched (the same names the install
scripts read — `telo-<version>-linux-amd64-gnu.tar.gz`) and verified against its published
`.sha256`, cached under the user cache root so a second package costs no download. A CLI version
that has no release cannot package a platform it is not itself running as, and says so naming the
version — which is the dev-checkout case, not the CI case.

**A platform with no published runtime is refused at the start, not at the fetch.** `--platform`
omitting `libc` on linux means `gnu`, stated in the summary so the choice is never silent; and
`linux/arm64/musl` has no official Node runtime to inject into, so no carrier exists and the refusal
says that rather than reporting a 404.

**Packaging from a source checkout goes through the checkout's own standalone build**, for the same
reason `telo runner` supervises the running executable rather than a `telo` on `PATH`: an
unreleased version has no release asset to fetch, so the only carrier that exists is the one just
built, and a single-file executable IS the command. CI builds the binary and invokes `telo package`
from it; a developer packaging locally does the same. There is no flag naming a carrier file — a
carrier and the CLI inside it are one version by construction, and a flag would be the seam where
they stop being.

**`telo package` is Node-only debt, declared.** `cli/rust` owes it, as it owes `telo runner`: the
command is part of the one `telo` surface. Which binary is the carrier the day both ship for one
platform is not a question for this plan, because §1.3's first predicate already answers it — a
carrier hosts what its kernel hosts, so the closure decides, not a preference stated here.

There is no `--telo-version`. The runtime a packaged app carries is the runtime of the CLI that
packaged it; a different runtime is a different CLI. That also settles the abi: every carrier of one
telo version embeds one pinned Node runtime, so the abi the layers are warmed for is baked at build
time beside the other version stamps rather than asked for on the command line.

**Placement is per executable format, because one of the three refuses trailing bytes.**

- **ELF and PE:** payload appended, followed by a fixed 52-byte trailer — format version, payload
  length, payload sha256 — ending in the 8-byte magic `TELOAPP1`. It records no absolute offset:
  the payload is the `length` bytes immediately before the trailer, which is what lets one reader
  serve both placements. Verified on linux-amd64-gnu that a carrier with trailing bytes still runs.
  Windows binaries are unsigned today, so nothing is invalidated.
- **Mach-O:** the identical payload and trailer bytes placed in a segment named `TELO_APP`. Data
  after `__LINKEDIT` is what "main executable failed strict validation" means, and an unsigned
  arm64 binary does not launch at all, so appending is not available here. The carrier's ad-hoc
  signature comes off, the segment goes in, and an ad-hoc signature goes back on — the order the
  standalone build already uses. **Packaging a darwin platform therefore requires a macOS host**, and
  is refused elsewhere naming that reason rather than writing a file that cannot launch. The
  injection is a second `postject` run on a carrier that already carries `NODE_SEA` — the same tool
  the standalone build drives, promoted from a dev dependency of this package to a runtime one so
  the shipped CLI can do it, and inlined into the binary like the rest.

**The darwin half is believed, not measured.** The ELF claim above was measured; nothing here has
run `postject` twice over one Mach-O, and `__LINKEDIT` has to stay last across both. So it is
proved first, on a Mac, before any other darwin work: a carrier that takes a second segment,
verifies under `codesign --verify --strict` and launches on arm64. If it does not hold, the cost is
darwin support, not the design — ELF and PE are independent of it.

**One reader for both.** At startup the binary reads the last 52 bytes of its own executable; a
matching magic gives the payload's length. Failing that, a Mach-O header is walked for
the `TELO_APP` segment. Failing both, this is an ordinary `telo` and nothing else happens — the cost
on the unpackaged CLI's startup path is one 52-byte read. The payload is checked against the
trailer's digest before it is used, so a false magic hit in a carrier's own data is caught rather
than unpacked.

**Verify.** On each format, `telo package` output runs its application and the unpackaged carrier
still runs every CLI command. On macOS, `codesign --verify --strict` passes on the packaged file and
it launches on arm64 without a Gatekeeper kill. Corrupt one byte of an appended payload and the
binary refuses with a digest mismatch instead of unpacking.

## 3. What the command takes

`telo package <manifest> --out <file> [--platform <os/arch[/libc]>]`

`--out` is required — the file name is the product's identity and there is no convention to derive
it from that would not be invented here. `--platform` defaults to the host. `.exe` is enforced on
windows platforms. The entry must be a `Telo.Application`; a `Telo.Library` is refused, as it is
everywhere else.

**The platform is spelled the way `telo install` already spells it** — `os/arch[/libc]`, the
OCI/GOOS vocabulary the published selectors, `native:` entries and platform-qualified controller
PURLs all use. `linux-amd64-gnu` is the *release asset's* name, a filename in the download
namespace, and keeping both spellings on one CLI would make a user translate between them to answer
one question.

`telo package` obeys the `Output` seam like every other command but `telo run`: the summary — app
name and version, platform and abi, payload size, output size and digest — is the result payload
under `-o json`, and progress stays on stderr.

**`telo package inspect <file>` reads any carrier** — packaged or not — and prints the payload index
and digest: app name and version, the entry manifest, the platform and abi, the telo version that
built it, and the modules and layers the payload carries. It reads the trailer or the segment and
nothing else, so it is cheap, it works on a file built by someone else's CLI, and it is what makes a
packaged binary auditable: CI can assert what got baked in, a support request can start from the
artifact, and every Verify step in this plan that says "confirm the payload holds X" is performed
with it. A file carrying no payload reports that and exits non-zero.

## 4. First run

**The payload is unpacked once, keyed by its digest.** `<cache root>/apps/<name>-<digest>/`, where
the cache root is `TELO_APP_DIR` when set, else the platform's user cache directory
(`$XDG_CACHE_HOME/telo` or `~/.cache/telo`, `~/Library/Caches/telo`, `%LOCALAPPDATA%\telo`), else a
temporary directory when none of those is writable — a read-only home is a deployment, not an error.
A hardened container with a read-only root and no tmpfs leaves nowhere at all, and that refuses at
startup naming `TELO_APP_DIR` and a writable volume, rather than surfacing whichever write happened
to fail first.
The directory is `0700` and every directory under it: it holds the application's source, the same
reason the local runner's session workspaces are private. Extraction goes to a sibling temporary
directory and is renamed into place, with the completion marker written last, so two copies starting
at once cannot serve each other a half-written tree.

**A successful start reclaims the app's other digests.** Every build of an app is a new digest, so
without this a deployment that ships ten versions leaves ten full closures under the user's cache
and nothing ever removes them. A running instance records itself under `live/<pid>` in its own tree,
and a start that has got its tree ready sweeps the sibling trees of the same app name that no living
process holds — the runner's PID sweep, which answers the question rather than guessing at an age.
A stale `live/<pid>` whose process is gone is swept with it. **Deletion is always safe**, which is
what makes this a sweep and not a policy: a reclaimed tree is reconstructible in full from the
binary that owns it, so the cost of being wrong is one extraction. A blue/green pair running two
versions side by side keeps both, because both are held.

**The unpacked cache is the app's cache root, and `TELO_CACHE_DIR` is ignored inside a packaged
app.** The cache is not an optimisation here — it is the payload. Honouring an external override
would point the kernel at a tree that holds none of the app's modules.

**The packaged dispatch calls `telo run`'s own implementation** — with the unpacked manifest as the
entry and the user's argv as the app's — never a leaner bootstrap written for the unpack sequence.
That is the standalone binary's existing rule ("there is no second code path") and here it is what
carries the behaviour a long-running service depends on: the SIGINT/SIGTERM handler that cancels the
boot run and unblocks the idle wait so effect chains unwind, and the process exiting on the
kernel's exit code rather than on a bare zero. A bespoke bootstrap would be a packaged service that
is SIGKILLed by its orchestrator thirty seconds into every rolling deploy.

**Every argument after the program name is the application's.** `./orders --port 8080` is what
`telo run ./telo.yaml -- --port 8080` is today. The CLI is unreachable from a packaged binary: there
are no subcommands, no `--watch`, no `--debug`, no `--inspect`, and `--version` means whatever the
application decides it means. That is the whole point of the distribution — the user of `./orders`
is not a telo user — and it is why the telo version that built it is recorded in the payload index
and printed by the packager instead.

**`TELO_APP_INFO=1` prints that index and exits**, before the application is loaded. An operator
holding only `./orders` on the machine it runs on can otherwise learn nothing about it — not its
version, not the telo behind it, not what was baked in — and asking them to fetch the packaging CLI
to read a file they already have is the wrong shape. An environment variable rather than an
argument because the argv contract above is absolute: the application owns every argument, and a
reserved one would make that a lie the day an app wants it.

**Env files are read from the working directory**, with the same walk and the same workspace-marker
bound as `telo run`, rather than from the unpacked tree, which is an implementation detail no
operator should have to find. **The walk needs an anchor it does not have today**: it starts at the
manifest's own directory, which for `telo run` sits at or near where the command was typed and here
never does, so reusing it unchanged would walk up out of the cache tree — the exact behaviour this
rule exists to avoid. The anchor becomes a parameter, cwd for a packaged app and the manifest's
directory everywhere else, so one walk keeps serving both. Variables, secrets and ports keep binding to the real environment
exactly as they do today.

**Verify.** Run a packaged app in a container that has never had Node.js, with the network off, and
confirm it serves. Run it twice and confirm the second start unpacks nothing. Run two copies
concurrently from a cold cache and confirm both serve. Run it with `HOME` unset and with the cache
root read-only. Set `TELO_CACHE_DIR` to an empty directory and confirm the app still runs. Confirm
`.env` beside the binary is applied and one baked into the closure does not exist. Start three
builds of one app in sequence and confirm one tree remains; start two and confirm that while both
run, both trees remain, and that killing one and starting the other reclaims the dead one's tree.
Send SIGTERM to a serving packaged app and confirm it drains, unwinds and exits 0, and that an app
whose run fails exits with the kernel's code rather than 0. Start one with no writable cache root
and no `TELO_APP_DIR` and confirm the refusal names both. `TELO_APP_INFO=1` prints the same index
`telo package inspect` prints for the same file.

## 5. Release, tests and docs

The mechanism has no manifest surface, so no module declares a floor and no migration is needed.
`@telorun/cli` takes one minor changeset covering both the command and §1.1's change to what
`telo install` exits with — the latter stated as the behaviour change it is, naming the flags a
build that relied on the warning now has to pass.

Unit coverage in the CLI package for the trailer round-trip on all three placements, the payload
index and its reader, the refusal paths (library entry, darwin off a Mac, unreleased carrier
version, a platform with no runtime, each portability predicate, an unwarmed layer, digest mismatch)
and the cache-root fallbacks and sweep. The packaged app's stamp key is covered where it can
actually fail — a payload unpacked at a path other than the one it was built at, asserting a hit.
One CI job builds the standalone binary, packages an example
for `linux/amd64/gnu` **with that binary**, and runs the result in the Node-less container the
standalone release already uses, which is the only place "no
Node.js" is a fact rather than an assumption; the musl container needs `libstdc++` first, as it
already does.

A guide at `docs/guides/packaging-an-app.md`, listed in the site's sidebar, covering the command,
what lands in the payload and what deliberately does not, the two portability predicates and what to
do when a closure is refused, the darwin host requirement, the argument and env contract, and how to
read a packaged binary. The CLI package guide gains a section beside the standalone binary's, since the two
now share a carrier, and the install command's entry there records that a skipped layer is now a
failure.
