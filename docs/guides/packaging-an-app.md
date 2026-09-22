---
description: "Ship a Telo application as one executable with telo package: what the payload carries, which controllers can travel, how arguments and .env reach it, and how to read a packaged binary."
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
only `codesign` does; on ELF and PE the payload is appended and any host can do
it.

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
manager (`pkg:npm`) or a toolchain (`pkg:cargo`) — today that is the `image` and
`starlark` modules, and any kind of your own with a `pkg:cargo` controller. The
refusal names the kind, the candidate and which of the two rules it failed.

Such an application still runs under an installed telo, which can reach a
package manager and a toolchain.

## Running it

**Every argument belongs to your application.** `./orders --port 8080` passes
`--port 8080` to the app exactly as `telo run ./telo.yaml -- --port 8080` does.
A packaged binary has no subcommands and no telo flags: its user is not a telo
user.

**Configuration** comes from the environment, as always — `variables:`,
`secrets:` and `ports:` bind the same env vars they always did. `.env` and
`.env.local` are read **from the working directory you run the binary in**, with
the same walk `telo run` uses.

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
needs; with nowhere writable at all, the app refuses at startup and says so.
`TELO_CACHE_DIR` is ignored inside a packaged app: the payload *is* its cache.

## Reading a packaged binary

```sh
telo package inspect dist/orders
```

prints what the file carries — application name and version, the entry manifest,
the platform and abi, the telo version that built it, every module inside, and
the payload's digest. It reads the trailer alone, so it is instant and works on
a file someone else built.

On the machine where the binary is deployed, `TELO_APP_INFO=1 ./orders` prints
the same index and exits without starting the application.

## Size

Every packaged app carries a Node runtime, so the file is around 140 MB
(roughly 47 MB compressed). That is the cost of a machine needing nothing
installed.
