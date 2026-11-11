---
description: "Ship a Telo application as one executable with telo package: what the payload carries, which controllers can travel, how arguments and .env reach it, desktop apps as a macOS bundle or Windows GUI executable and how to sign them, how to read a packaged binary, and how TELO_APP_CLI reaches the telo inside it."
---

# Packaging an application

`telo package` turns an application into a single file that runs on a machine
with no Node.js, no telo and no network.

```sh
telo package ./telo.yaml --out dist/orders
./dist/orders
```

The file is the released `telo` binary for the platform with your application
carried inside it: the manifest, every local file it reaches, and the whole
resolved import closure — imported manifests, controller bundles, native files
and module assets — already warmed. Nothing is fetched at run time.

## What is in it

- **Your application's files**, computed from the manifest graph rather than
  copied from the project directory: partials, local imports, embedded
  (`!include-text` / `!include-bytes`) files, every file under a
  `!module-path` directory, and module assets.
- **Every module you import**, materialized for the platform you named.
- **Every child application**: an application started by a resource whose kind
  declares `x-telo-application-source` (`App.Instance`) travels with its parent —
  its manifest, files, import closure and built local modules, each held to the
  same portability check — and its relative `source:` resolves inside the
  unpacked tree. The child loads from the payload's sealed cache, offline, and
  `telo package inspect` lists its modules with the parent's. Under a
  `TELO_HOST_STATE_DIR` the child's state is `apps/<path>` beneath it.
- **A local module's built code.** A module reached by a relative `source:` —
  including the application's own `Telo.Definition`s — is built at package time
  and travels as its `path=` bundle. Its TypeScript sources do not travel, which
  is what guarantees nothing compiles on the target machine.
- **The warmed analysis verdict**, so a packaged app re-validates nothing at
  startup — while still checking that the files it loads are the files that
  verdict was about, so an unpacked tree that was truncated or edited is
  re-validated rather than trusted.

Packaging is refused, rather than half-done, when the application names a file
that is not there — an unbuilt controller, an unstaged native file, a missing
embedded file — so an incomplete payload is never written.

`.env` and `.env.local` are never packaged. They are configuration, they often
hold secrets, and a packaged binary is extractable by anyone holding it — see
*Configuration* below for where they are read instead.

## Choosing a platform

`--platform` takes the same `os/arch[/libc]` spelling as `telo install`:

```sh
telo package ./telo.yaml --out dist/orders --platform linux/arm64
telo package ./telo.yaml --out dist/orders --platform linux/amd64/musl
```

It defaults to the host. On linux, an omitted `libc` means `gnu`, and packaging
says so. `linux/arm64/musl` has no published runtime, so no such binary can
exist and the command refuses rather than failing at the download.

**Packaging a darwin platform requires a macOS host.** On Mach-O the payload
goes into a segment of its own and the binary is re-signed afterwards, which
only `codesign` does; on ELF and PE the payload is appended (a Windows desktop
app carries it as a resource instead) and any host can do it.

**The binary carries the telo that packaged it**, and that is enforced rather
than assumed. There is no flag to choose another version, and only a *released*
telo may download a carrier — because a working copy and the release of the same
version number are different code, so a downloaded carrier would carry the
release while the command claimed it carried what built it, leaving every local
change silently out of the result.

So from a source checkout, build that checkout's own binary and package with it:

```sh
pnpm --filter @telorun/cli build:standalone
./cli/nodejs/dist-standalone/telo package ./telo.yaml --out dist/orders
```

That binary is the carrier for its own platform. Packaging for *another*
platform needs an installed telo release — the one case where a downloaded
carrier is the telo doing the packaging.

## Which controllers can travel

A payload carries only controllers that are **files on the target machine**. Two
things are checked per candidate:

1. the carrier's kernel opens that controller format, and
2. the candidate needs no external program where the app will run.

A kind passes as soon as one of its candidates satisfies both, so a kind
offering a bundled controller beside a crate-built one is fine, and only the
kinds your application actually declares a resource of are judged — importing a
module that happens to declare one crate-built kind you never use costs nothing.
What is refused is a kind you *do* use whose every candidate needs a package
manager (`pkg:npm`) or a toolchain (`pkg:cargo`) — no standard-library kind
today, but a kind of your own with only a `pkg:cargo` controller. The
refusal names the kind, the candidate and which of the two rules it failed.

Such an application still runs under an installed telo, which can reach a
package manager and a toolchain.

## Running it

**Every argument belongs to your application.** `./orders --port 8080` passes
`--port 8080` to the app exactly as `telo run ./telo.yaml --port 8080` does — read
against the `arg:` bindings the application declares. The binary's user is not a
telo user, so nothing on its command line reaches telo; the telo inside it is
reached through `TELO_APP_CLI=1` instead (*The telo inside it*, below).

**Configuration** comes from the environment, as always — `variables:`,
`secrets:` and `ports:` bind the same env vars they always did. `.env` and
`.env.local` are read **from the working directory you run the binary in**, with
the same walk `telo run` uses.

**Needs are provided the same way.** `telo needs report dist/orders` lists them,
and `TELO_HOST_STATE_DIR`, the public-URL templates and the `TELO_NEED_…`
variables are read as under `telo run` ([Providing needs](/learn/providing-needs)).
Under a supervisor, with no terminal, an input nothing supplies is refused and the
binary exits with status 1; at a terminal it asks. To refuse there too, start the
telo inside it with the option: `TELO_APP_CLI=1 ./orders run --no-input ./orders`.

**Files the application writes live in the working directory, not in the
payload.** The payload unpacks to a cache directory (below) that belongs to the
binary, so anything the manifest locates relative to *itself* lands there. Name
runtime data — an output directory, a database file — with a variable typed
`x-telo-type: Telo.HostPath`: its value, relative or not, resolves against the
working directory, the same directory `.env` is read from and, when the binary is
started by double-click, the one it sits in. Files that ship with the app — a
frontend — are written with `!module-path`, and resolve inside the payload.

**Signals and exit codes are unchanged.** SIGTERM and SIGINT unwind the app the
way they do under `telo run`, so a packaged service drains and exits cleanly
when an orchestrator rolls it.

The payload unpacks once into the user cache
(`~/.cache/telo/apps/<name>-<digest>`, `~/Library/Caches/telo` on macOS,
`%LOCALAPPDATA%\telo` on Windows), so later starts pay nothing. A successful
start reclaims the same application's older trees, provided no live process is
using them — a reclaimed tree comes straight back out of the binary, so nothing
is lost. `TELO_APP_DIR` moves that root, which is what a read-only container
needs; with nowhere writable at all, the app refuses at startup and says so. An
unprivileged user needs only that directory (or `HOME`, or a writable temporary
directory) — see [Running unprivileged](/deploy/production#running-unprivileged).
`TELO_CACHE_DIR` is ignored inside a packaged app: the payload *is* its cache.

## A desktop app

A root `Telo.Application` that declares a `Telo.DesktopHost` need is packaged as a
desktop app, with no flag: `telo package ./hello-desktop --out dist/Hello`. Its
`icon` must be a square PNG of at least 1024 px, or packaging refuses
(`icon.png must be square and at least 1024 px (it is 512 × 512)`) and writes
nothing. The helper that owns the windows (`telo-desktop-host`) is obtained for
the platform being packaged — `TELO_HOST_DESKTOP_HELPER` or a source checkout's
own build for the machine's platform, else the release asset — and travels with
the app, so it still starts offline. `telo package inspect` prints `desktopHost: { identifier }`.

What is written depends on the platform:

- **macOS** — `--out dist/Hello` writes the application bundle `dist/Hello.app`.
  `Contents/Info.plist` carries the need's `identifier` (`CFBundleIdentifier`),
  `productName` (`CFBundleName`, `CFBundleDisplayName`), the root's
  `metadata.version` (`CFBundleShortVersionString`, `CFBundleVersion`),
  `LSMinimumSystemVersion` 14.0, and `LSUIElement` when `showInDock: false`; the
  icon becomes `Contents/Resources/AppIcon.icns`. The executable in
  `Contents/MacOS/` is named after `productName` (`/` and `:` become `-`) and the
  helper sits beside it as `Contents/MacOS/telo-desktop-host`, outside the
  payload. Both are signed ad hoc.
- **Windows** — `dist/Hello.exe`, a GUI-subsystem executable: starting it opens
  no console window. It carries the icon (256 px down to 16 px) and a version
  resource (`ProductName`, `FileDescription`, `ProductVersion`, `FileVersion`)
  that Explorer and Task Manager show, and its payload as a resource, with the
  helper inside the payload.
- **Linux** — the plain executable, the helper in its payload.

`package inspect` reads a bundle by its own path —
`TELO_APP_CLI=1 dist/Hello.app/Contents/MacOS/Hello package inspect dist/Hello.app`,
or `telo package inspect dist/Hello.app` from any telo. A GUI executable on
Windows has no console to print to, so read it with an installed telo
(`telo package inspect dist\Hello.exe`), or redirect its output to a file.

The binary hosts itself: its working directory is the per-user application
directory of the `identifier` (`$XDG_DATA_HOME/<identifier>` or
`~/.local/share/<identifier>`, `~/Library/Application Support/<identifier>`,
`%LOCALAPPDATA%\<identifier>`), `.env` is read there, and `TELO_HOST_STATE_DIR`
is `<that directory>/state`, so every `Telo.DurableDirectory` need — a child web
app's included — lands under `state/` with no setting. A state directory the
environment already names is kept. When the environment supplies the host instead
(`TELO_NEED_…` set) the binary keeps the working directory it was started in and
only reads its `.env` from the per-user directory.

### Signing a desktop app

Signing is your step, done after packaging and before you distribute the file.

**macOS.** Sign the bundle with your Developer ID and the hardened runtime, then
notarize and staple it:

```sh
codesign --force --deep --options runtime --timestamp \
  --entitlements entitlements.plist --sign "Developer ID Application: …" dist/Hello.app
ditto -c -k --keepParent dist/Hello.app dist/Hello.zip
xcrun notarytool submit dist/Hello.zip --keychain-profile … --wait
xcrun stapler staple dist/Hello.app
```

The payload sits inside the carrier's Mach-O image, so the signature covers it
and nothing follows it. The hardened runtime needs the entitlements the Node
runtime inside asks for — `com.apple.security.cs.allow-jit` and
`com.apple.security.cs.allow-unsigned-executable-memory` — and
`com.apple.security.cs.disable-library-validation` when the app loads a native
controller, since those are unpacked from the payload and are not signed by your
team.

**Windows.** Sign the executable with `signtool`:

```sh
signtool sign /fd SHA256 /tr <timestamp URL> /td SHA256 /f cert.pfx dist\Hello.exe
```

Signing writes the certificate after the image and rewrites the checksum. The
payload is a resource inside the image, so signing leaves it intact.

Not yet confirmed on a real machine: a bundle launching on macOS and passing
`codesign` and notarization, a `signtool`-signed executable starting, and Windows
starting the GUI executable. What packaging writes — the bundle, `Info.plist`,
the `.icns`, the subsystem, checksum and resources, and a payload still found once
a certificate table follows the image — is checked by reading the bytes back.

## Reading a packaged binary

Every telo command that takes a manifest takes a packaged binary in its place —
`describe`, `check`, `needs report`, `env template`, `cel functions` and `run`:

```sh
telo describe dist/orders
telo needs report dist/orders
```

The payload is unpacked into the same directory the binary itself uses and read
from there, and nothing it carries is executed, so describing a binary prints
exactly what describing its manifest prints.
Reading changes nothing in that directory and asks no registry about a module
the payload holds, so it works offline and leaves the binary's next start
exactly as it was.

```sh
telo package inspect dist/orders
```

prints what the file carries — application name and version, the entry manifest,
the platform and abi, the telo version that built it, every module inside, and
the payload's digest and where it rides (`placement`: `appended`,
`macho-segment` or `pe-resource`). It reads the trailer alone, so it is instant
and works on a file someone else built.

## The telo inside it

A packaged binary carries the telo that packaged it, and `TELO_APP_CLI=1` makes
the binary that telo for one start — so on the machine where it is deployed,
with no telo installed, you can still describe, check, inspect or run it with
every telo option:

```sh
TELO_APP_CLI=1 ./orders describe ./orders
TELO_APP_CLI=1 ./orders package inspect ./orders
TELO_APP_CLI=1 ./orders run --inspect --debug ./orders --port 8080
```

`./orders <arguments>` is exactly `TELO_APP_CLI=1 ./orders run ./orders
<arguments>`: the same unpacked directory, the same cache, `.env` read from the
working directory — and a `--debug` log, `.telo.debug.jsonl`, written there too.
Unset or empty, the variable means the application; any value other than `1` is
refused before anything starts, with exit status 2. Every telo removes it from its own environment
when it starts, so your application and anything it spawns never see it.

`TELO_APP_INFO` is retired: a binary started with it set refuses (exit status
2) and names the `package inspect` command above instead.

## Size

Every packaged app carries a Node runtime, so the file is around 140 MB
(roughly 47 MB compressed). That is the cost of a machine needing nothing
installed.
