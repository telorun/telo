---
status: done
priority: high
depends-on: []
packages: [analyzer, kernel, sdk, cli, packages/runner-core, packages/secret-seed, apps/docker-runner, apps/k8s-runner, apps/host-runner, apps/authoring-agent]
refinement: not-started
---

# Host values — remaining work

Order: 1, then 2. The state-directory half of 2 does not depend on 1 and may ship first.

---

## Problem

A library that needs a key or a password has nowhere to get one but an env variable someone must set, in the exact format the library decodes. A session application on a runner, and a packaged desktop app, cannot be given either a stable secret or (on a runner) a state directory, so a need of either kind ends in `ERR_NEED_UNMET` where nobody can set a variable.

## Constraints

None.

## Surface

**Added**
- `Telo.GeneratedSecretKey` — kernel-declared need type: parameters `bytes`, `encoding`; sensitive field `key`.
- `Telo.GeneratedPassword` — kernel-declared need type: parameters `length`, `characterSets` (entries `{ characters, minimum }`); sensitive field `password`.
- `TELO_HOST_SECRET_SEED` — host value: the 32-byte seed both types are derived from; hidden from controllers and stripped from a started child.
- `TELO_NEED_<PATH>__KEY` / `TELO_NEED_<PATH>__PASSWORD` — the env name an operator supplies one need's value through.
- `NEED_VALUE_INVALID` / `ERR_NEED_VALUE_INVALID` — a supplied key or password that its need's parameters refuse.
- `@telorun/secret-seed` — new MIT package (`packages/secret-seed/`, off the telo line): the seed's encoding and refusal, the `secret-seed` file read-or-create, and the derivation of a child seed from a seed and a label; its README is the spec, `packages/secret-seed/conformance/` its vectors.
- `RUNNER_SECRET_SEED` — runner root seed, when set.
- `secret-seed` in a runner's state directory — the runner root seed a SQLite-store runner keeps.
- `secretSeed.existingSecret` / `secretSeed.existingSecretKey` (default `seed`) — k8s chart values naming the Secret and key holding `RUNNER_SECRET_SEED`.
- `apps/<app name>/` of a session's storage — a session application's state directory, mounted at `/var/lib/telo-apps/<app name>` in a container.
- `desktop-host/secret-seed` of the per-user directory — the desktop host's seed.
- `<workspace dir>/.telo/state/<app directory relative to it>/_` — the `TELO_HOST_STATE_DIR` a plain `telo run` sets when nothing names one.
- `TELO_HOST_SECRET_SEED=` line in the workspace's sensitive env file (`.env.local` by default) — the seed `telo run` generates at a terminal when asked to.

**Changed**
- `NEED_FORWARD_INCOMPATIBLE` / `ERR_NEED_FORWARD_INCOMPATIBLE` — also refuses, for every need type, a whole forward whose need does not state every parameter the supplied need states with an equal value.
- `ERR_NEED_HOST_VALUE_INVALID` — also raised for a malformed `TELO_HOST_SECRET_SEED` or desktop-host `secret-seed` file.
- The default cache root `<workspace dir>/.telo` — moves to `<workspace dir>/.telo/cache` (`manifests/`, `analysis/`, `layers/`, … beneath it); `TELO_CACHE_DIR` still names the cache root itself.

## 1. `Telo.GeneratedSecretKey` and `Telo.GeneratedPassword`

**Today.** No such types, no `TELO_HOST_SECRET_SEED`. A secret a module needs is supplied by an env name or not at all; the kernel hides and strips from a started child only its host values: the two public URL templates, `TELO_HOST_STATE_DIR` and `TELO_HOST_DESKTOP_HELPER`. A whole forward between needs of one type compares `version`, `features` and `Telo.DurableDirectory`'s `size` / `access`, and passes any other parameter difference silently.

**Decision.** Two kernel-declared need types answered from one host value, like `Telo.DurableDirectory`. Neither is `supply: root` or `unique`.

- **`Telo.GeneratedSecretKey`** — key material a library decodes to an exact number of bytes. Parameters, both required: `bytes` (integer 16–1024) and `encoding`, one of `base64url` (unpadded), `base64url-padded`, `base64` (RFC 4648 §4, padded) and `hex` (lowercase). Field `key`, a sensitive string: the bytes in that encoding.
- **`Telo.GeneratedPassword`** — text a library uses as it is. Parameters, both required: `length` (integer 1–1024) and `characterSets`, at least one entry `{ characters, minimum }` — `characters` a string of printable ASCII (U+0021–U+007E), no character twice within or across sets; `minimum` an integer ≥ 0, default 0, the sum of minimums at most `length`. The password draws from the union of the sets and holds at least `minimum` characters of each. Field `password`, a sensitive string.
- **Parameters** are literals; any rule above broken is `NEED_PARAMETERS_INVALID` at the need (`ERR_NEED_PARAMETERS_INVALID` at load). A library's need states them as a root's does.
- **Derivation.** From `TELO_HOST_SECRET_SEED` (32 bytes, unpadded base64url): PRK = HKDF-SHA256-Extract(empty salt, seed); block *i* (0, 1, …) = HKDF-Expand(PRK, info ‖ 0x00 ‖ uint32be(*i*), 32); the stream is the blocks in order. `info` = `telo/<kind>/<need path>/<RFC 8785 canonical JSON of the need's parameters, defaults filled>`, taken from the outermost need. A key is the first `bytes` bytes of the stream, encoded. A password draws characters with `draw(m)`: the next two stream bytes as a big-endian `v`, accepted when `v < 65536 − 65536 mod m` and yielding `v mod m`, else drawn again. It draws each set's `minimum` characters from that set, sets in written order, then the remaining `length − Σ minimum` from the union (sets, then their characters, in written order), then shuffles: for *i* from `length − 1` down to 1, swap position *i* with `draw(i + 1)`. A pure function of seed, kind, path and parameters — the same seed gives the same value on every restart, reload and resume, and two needs, two kinds or two parameter sets never share bytes. It is derived rather than stored in the state directory, where it would sit beside the data it protects, in its backups and within reach of any kind that serves the directory.
- **Identity.** A value's identity is its outermost need's kind, path and parameters. Renaming the need, moving it into a library (its path becomes `<Library>.<need>`) or changing a parameter changes the value and reports nothing; keeping the old root need and forwarding it whole to the library's need keeps the value.
- **Forwarding.** A generic need-table rule, for every need type: a need forwarded whole must state every parameter the supplied need states (defaults filled) with an equal value, or it is `NEED_FORWARD_INCOMPATIBLE` / `ERR_NEED_FORWARD_INCOMPATIBLE`, at an `imports:` supply and at a child application's `needs:` alike. `Telo.DurableDirectory`'s ordered `size` / `access` comparison stays its own; a library's parameterless `Telo.PublicUrl` / `Telo.DesktopHost` need states nothing and is unaffected. A key or password is consumed exactly, so "at least" does not apply: a library asking for 32 bytes breaks on 64.
- **Precedence.** A `needs:` supply at an import or instance, then the field's env name (`TELO_NEED_<PATH>__KEY` / `__PASSWORD`), then the host value. A field of either type is never asked for at a terminal; what `telo run` offers there instead is section 2's. With none, `ERR_NEED_UNMET` naming `TELO_HOST_SECRET_SEED` and the env name; a seed that does not decode to 32 bytes is `ERR_NEED_HOST_VALUE_INVALID`, naming the variable, never its value.
- **Supplied values.** Every value that does not come from the derivation is held to the need's parameters: a key must decode under `encoding` to exactly `bytes` bytes and be that encoding's canonical text (lowercase hex, padding exactly as named); a password must be exactly `length` characters of the union with every `minimum` met. This holds for the env name, a parent's or importer's `needs:` supply and a fulfilment's `fields:`. A literal that fails is `NEED_VALUE_INVALID` from `telo check`; any failing value is `ERR_NEED_VALUE_INVALID` at load, before any resource initializes. The message names the need, where the value came from and the rule broken, never the value.
- **Child applications.** The seed reads `undefined` from `process.env` and `ctx.env` and is stripped from the environment a started child inherits, with the other host values. A child declaring either type therefore gets `ERR_NEED_UNMET` unless its instance supplies it through `needs:`. `TELO_HOST_CONTAINER_ENGINE_*` still reaches children.

```yaml
# shop/telo.yaml
kind: Telo.Application
metadata: { name: Shop }
imports:
  Console: oci://ghcr.io/telorun/console@0.19.3
  Jose: oci://ghcr.io/telorun/jose@0.3.1
  App: oci://ghcr.io/telorun/app@0.7.0
needs:
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
  dbPassword:
    kind: Telo.GeneratedPassword
    parameters:
      length: 24
      characterSets:
        - { characters: abcdefghijklmnopqrstuvwxyz, minimum: 1 }
        - { characters: ABCDEFGHIJKLMNOPQRSTUVWXYZ, minimum: 1 }
        - { characters: "0123456789", minimum: 1 }
targets:
  - invoke: { kind: Jose.Encrypt, secret: !cel "resources.sessionKey.key" }
    inputs: { payload: { user: ada } }
  - invoke: { kind: Console.WriteLine }
    inputs:
      output: !interpolate "root key is ${{ size(resources.sessionKey.key) }} characters, password ${{ size(resources.dbPassword.password) }}"
  - !ref web
---
kind: App.Instance
metadata: { name: web }
source: ./web
needs: { sessionKey: !ref sessionKey }
```

```yaml
# shop/web/telo.yaml
kind: Telo.Application
metadata: { name: Web }
imports:
  Console: oci://ghcr.io/telorun/console@0.19.3
needs:
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
targets:
  - invoke: { kind: Console.WriteLine }
    inputs:
      output: !interpolate "web key is ${{ size(resources.sessionKey.key) }} characters"
```

```
$ telo run ./shop
ERR_NEED_UNMET: need 'sessionKey' (Telo.GeneratedSecretKey, declared by ./) has no value; set TELO_HOST_SECRET_SEED, or TELO_NEED_SESSION_KEY__KEY

$ TELO_HOST_SECRET_SEED=short telo run ./shop
ERR_NEED_HOST_VALUE_INVALID: TELO_HOST_SECRET_SEED must be 32 bytes of unpadded base64url

$ export TELO_HOST_SECRET_SEED=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d =)
$ telo run ./shop
root key is 43 characters, password 24
web key is 43 characters

$ TELO_NEED_SESSION_KEY__KEY=abc telo run ./shop
ERR_NEED_VALUE_INVALID: need 'sessionKey' (Telo.GeneratedSecretKey, declared by ./): TELO_NEED_SESSION_KEY__KEY does not decode as base64url to 32 bytes
```

With the instance's `needs:` line removed, `web` refuses at its start: `ERR_NEED_UNMET: App.Instance 'web': need 'sessionKey' (Telo.GeneratedSecretKey, declared by ./web) has no value; supply `needs: { sessionKey: … }` on the instance`. With `web` declaring `bytes: 64`, `telo check ./shop` reports `NEED_FORWARD_INCOMPATIBLE` at the instance's `needs:` entry, naming both parameter sets.

A library's need, and the root forwarding it whole so the value survives the move:

```yaml
# auth/telo.yaml
kind: Telo.Library
metadata: { name: Auth, version: 1.0.0 }
imports:
  Jose: oci://ghcr.io/telorun/jose@0.3.1
needs:
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
exports: { resources: [seal] }
---
kind: Jose.Encrypt
metadata: { name: seal }
secret: !cel "resources.sessionKey.key"
```

```yaml
# shop/telo.yaml
kind: Telo.Application
metadata: { name: Shop }
imports:
  Auth: { source: ../auth, needs: { sessionKey: !ref sessionKey } }
needs:
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
targets:
  - invoke: !ref Auth.seal
    inputs: { payload: { user: ada } }
```

**Verify.**
- With a fixed seed, each `encoding` and a password with minimums equal the values pinned in shared derivation vectors, which the Node kernel runs here and the Rust kernel's parity slice must meet. A value reads the same across restarts; two needs, the two kinds, and one need under two parameter sets differ, the longer key sharing no prefix with the shorter.
- With the seed unset, `ERR_NEED_UNMET` naming `TELO_HOST_SECRET_SEED` and the need's env name. A seed of the wrong length or alphabet is `ERR_NEED_HOST_VALUE_INVALID`, and the output never contains it.
- Malformed parameters — `bytes: 8`, an unknown `encoding`, a character outside printable ASCII, one character in two sets, minimums summing past `length` — are `NEED_PARAMETERS_INVALID` at the need and refused at load.
- `TELO_NEED_SESSION_KEY__KEY` holding 31 bytes, uppercase hex for a `hex` key or padding for a `base64url` key, and a supplied password missing a set's minimum, are `ERR_NEED_VALUE_INVALID` naming the variable and never the value; the same literal in a fulfilment's `fields:` is `NEED_VALUE_INVALID` from `telo check`. A valid value boots and the seed is not consulted for that need.
- A whole forward with a differing `bytes`, `encoding` or `characterSets` is refused by `telo check` and before boot, with rows in both halves of `tests/check-run-agreement.yaml`; equal parameters boot and the library reads the root's value; a library's parameterless `Telo.PublicUrl` need still accepts a parameterized root need.
- Renaming `sessionKey` or changing a parameter boots with a new value and reports nothing; forwarding the renamed library need from a root need still named `sessionKey` keeps the old value. Nothing is written under the state directory.
- A child instance without `needs:` for its secret refuses at its start; with it, the child reads the parent's value. A controller reading `process.env.TELO_HOST_SECRET_SEED` gets `undefined`, in the parent and in a child.

**Docs / release.** Root `CLAUDE.md`, analyzer and kernel guides (the whole-forward parameter rule beside the existing ones), `docs/guides/providing-needs.md` (both types, the parameters, the identity rule, and that two applications under one seed share a value for one need path, kind and parameter set), `docs/reference/diagnostics.md` (`NEED_VALUE_INVALID`, the widened `NEED_FORWARD_INCOMPATIBLE`) and `environment-variables.md`, the authoring-agent primer, `docs/guides/what-you-get.md` (generated keys and passwords in the format a library needs, which a host never stores). Release fragments for analyzer, kernel, sdk, cli. A module adopting either type takes its floor from `telo release floor`. The Rust kernel gets the types through the `rust-parity` skill, not here.

---

## 2. Runners, the desktop host and `telo run`

**Today.** There are three runners over runner-core: docker, k8s and the host runner (`telo-host-runner`, the local-process backend). The k8s runner sets the public URL templates and routes the `publicUrls` hosts. No runner gives an application a state directory or a seed — the only `TELO_HOST_STATE_DIR` a runner sets is the co-resident agent's own. Every runner keeps its session records in `sessions.sqlite` in its state directory (`RUNNER_STATE_DIR`; the host runner's state root is `--state-dir`, then `RUNNER_STATE_DIR`, then the platform's per-user directory) unless `RUNNER_SESSION_STORE=postgres`. A session's application with a `Telo.DurableDirectory`, `Telo.GeneratedSecretKey` or `Telo.GeneratedPassword` therefore reaches `ERR_NEED_UNMET`. The desktop host gives an app a per-user directory — `desktop-host/` (the lock, `port`, the webview store) for the host, `state/` as `TELO_HOST_STATE_DIR` — but no seed, so a packaged app declaring either generated type fails for an end user who cannot set environment variables. A plain `telo run` sets neither a seed nor a state directory: at a terminal it asks the user to type each generated value and each `Telo.DurableDirectory` path as a missing need field (application arguments §4.1), and under `--no-input` it refuses with `ERR_NEED_UNMET`. The cache root is `.telo/` itself — in the directory holding `telo-workspace.yaml`, else the entry's directory — so nothing else can live there.

**Decision.** One rule for every host: a host whose durable state root has a single writer generates 32 random bytes once into a `secret-seed` file there (exclusive create, mode `0600`, holding the seed as unpadded base64url) and reads it from then on; a host whose records are shared takes the seed from its operator; a value the environment supplies always wins; a value or file that does not decode to 32 bytes refuses, naming the variable or the file and never its contents, and the file is never regenerated. All of it is implemented once, in a new MIT package `@telorun/secret-seed`, which the kernel (to decode `TELO_HOST_SECRET_SEED`), runner-core and the CLI's desktop host depend on: the CLI is MIT and may not depend on runner-core, and runner-core must not depend on a kernel generation. The package names no host vocabulary: it decodes a seed, refuses one with a sentence naming its source (the variable or the file, never the value) that each host attaches its own code to, reads or creates a `secret-seed` file (on Windows the directory's inherited ACL in place of mode `0600`), and derives a child seed — HKDF-SHA256, empty salt, the caller's label as `info`, 32 bytes. It stays off the telo version line, since one runner hands seeds to kernels of many generations; its README is the spec and `packages/secret-seed/conformance/` the vectors a later Rust twin (`telorun-secret-seed`, made with the change giving `cli/rust` a desktop host or the Rust kernel `needs:`) must meet.

- **Runners.** Runner-core delivers `TELO_HOST_STATE_DIR` and `TELO_HOST_SECRET_SEED` in the environment of every Run of a session's application, each application its own, overwriting any client-supplied value of either, as it already does for the container-engine values. The runner reads no manifest and no report.
- **Runner root seed.** `RUNNER_SECRET_SEED` (32 bytes, unpadded base64url) when set. Unset with the SQLite session store (the default), core keeps it in `secret-seed` in the runner's state directory, beside `sessions.sqlite` — on every runner, the k8s runner's state claim included. Unset with the PostgreSQL store, no seed is delivered, the runner logs one startup warning naming `RUNNER_SECRET_SEED`, and a session application declaring either generated type gets `ERR_NEED_UNMET`; replicas share records but not a state directory, so only an operator-supplied value can agree. Setting `RUNNER_SECRET_SEED` later, deleting `secret-seed` or rotating the variable rotates every session's secrets. The k8s chart takes it from a Secret reference (`secretSeed.existingSecret`, key `secretSeed.existingSecretKey`, default `seed`), as `sessionStore` takes its URL. The host runner strips `RUNNER_SECRET_SEED` from every process it spawns.
- **Per-application seed.** Core derives each application's seed per Run through the package's child derivation, the label `telo/secret-seed/<session id>/<app name>` composed in runner-core (neither part holds `/`). Nothing is stored beside the root, so a second replica sharing it, a restart, a suspend and a resume all give the same value.
- **State.** Each application's state directory is `apps/<app name>/` of the session's existing storage — `<session id>/apps/<app name>` on the docker runner's bundle volume, `apps/<app name>` of the session's claim `telo-session-<id>` on k8s, `sessions/<session id>/apps/<app name>` of the host runner's state root — and its kernel `needs/` and `apps/<path>` sit beneath it. Like `workspace/` and `agent/`, it belongs to the session user (the docker runner creates and gives it before creating `app-<name>`; the host runner creates it `0700`) and is kept by suspend and removed with the session. The k8s pod stays independent of the app set (its init container creates `apps/`, mounted once into the `apps` container). The docker runner mounts it into `app-<name>` through a volume subpath at `/var/lib/telo-apps/<app name>`, and the k8s `apps` container mounts the claim's `apps/` once at `/var/lib/telo-apps`, so `TELO_HOST_STATE_DIR` reads the same on both; on the host runner it is the directory's absolute path. An application is identified by its name in the session: renaming one gives a new directory and new secrets.
- **The cache moves to `.telo/cache`.** Both kernels resolve the default cache root as `<workspace dir>/.telo/cache`, the workspace dir being the directory holding `telo-workspace.yaml`, else the entry's directory; `TELO_CACHE_DIR` keeps naming the cache root and wins. A cache at the old place is never read or moved: a run fetches again, and a tree an older CLI installed for offline use is installed again. "Clear the cache" becomes deleting `.telo/cache` in every doc, since `.telo/` now holds data.
- **`telo run`'s state directory.** When neither the environment nor an env file names `TELO_HOST_STATE_DIR`, `telo run` sets it to `<workspace dir>/.telo/state/<app directory relative to the workspace dir>/_` (`.telo/state/_` for an app at the workspace dir, `.telo/state/examples/durable-orders/_` for one below it), without asking and under `--no-input` too; `TELO_CACHE_DIR` does not move it. Each application gets its own, because two sharing one state directory would share every need of the same name and see each other's as orphans (`ERR_NEED_ORPHANED`); the `_` leaf keeps one application's directory from ever being another's `needs/` or `apps/`. The path is derived every run, so nothing is saved, and `.telo/` is already git-ignored where Telo projects ignore it. A packaged executable that is not a desktop host, and an entry that is no local file (an `http(s)` or `oci://` ref), anchor at the working directory with the key `_`. A desktop host keeps its per-user `state/`, and runners set their own value, which wins.
- **`telo run` at a terminal.** When the reading leaves a generated need's field unanswered and no seed is set, the kernel hands the input resolver one entry for the host value — identity `host TELO_HOST_SECRET_SEED`, sensitive, marked generable — in place of the need fields, which are never asked for. The CLI asks `TELO_HOST_SECRET_SEED is not set — generate one and save it to <file>? [Y/n]`, `<file>` being the workspace's sensitive env file (the last sensitive entry of `env.files`, `.env.local` by default, beside the manifest or in a packaged app's working directory). Yes generates 32 random bytes through `@telorun/secret-seed`, appends `TELO_HOST_SECRET_SEED=<seed>` there with the writer the prompt's save offer already uses (warning when the file is not git-ignored), and answers the entry; every later run reads the seed from that file, so the values stay the same. Generating and saving are one step — a seed is never used unsaved — so a failed write refuses the run naming the file, and No declines, ending in `ERR_NEED_UNMET`. Under `--no-input`, a pipe or CI nothing is asked and nothing is written; a `--watch` session asks once. The question never arises for a desktop host (it keeps its own seed) or a runner's session (runners pass `--no-input` and deliver the seed).
- **Desktop host.** When `telo run` is the desktop host and holds the single-instance lock, it keeps the seed in `desktop-host/secret-seed` of the per-user directory and answers `TELO_HOST_SECRET_SEED` from it unless the environment, env files included, names one.

A session application using both halves:

```yaml
# a session application's telo.yaml
kind: Telo.Application
metadata: { name: Web }
imports:
  Console: oci://ghcr.io/telorun/console@0.19.3
needs:
  uploads: { kind: Telo.DurableDirectory }
  sessionKey: { kind: Telo.GeneratedSecretKey, parameters: { bytes: 32, encoding: base64url } }
targets:
  - invoke: { kind: Console.WriteLine }
    inputs:
      output: !interpolate "uploads at ${{ string(resources.uploads.path) }}, key ${{ size(resources.sessionKey.key) }} characters"
```

Before — a Run of `web` in session `s1`:

```
ERR_NEED_UNMET: need 'uploads' (Telo.DurableDirectory, declared by ./) has no value; set TELO_NEED_UPLOADS__PATH
```

After:

```
# SQLite store (the default): nothing to set
$ telo-host-runner --state-dir ./runner-state
$ ls -l ./runner-state
sessions.sqlite
sessions/
secret-seed            # mode 0600

# a Run of `web` in session s1 on the docker or k8s runner receives, beside the session's own env
TELO_HOST_STATE_DIR=/var/lib/telo-apps/web
TELO_HOST_SECRET_SEED=<43 characters, unpadded base64url>
# on the host runner: TELO_HOST_STATE_DIR=<abs>/runner-state/sessions/s1/apps/web

# the application prints
uploads at /var/lib/telo-apps/web/needs/uploads, key 43 characters

$ RUNNER_SECRET_SEED=short telo-host-runner --state-dir ./runner-state
telo-host-runner: RUNNER_SECRET_SEED must be 32 bytes of unpadded base64url

$ telo-host-runner --state-dir ./runner-state      # secret-seed truncated
telo-host-runner: ./runner-state/secret-seed does not hold 32 bytes of unpadded base64url

# the desktop host: first start of a packaged Shop, then a truncated file
$ ./Shop
$ test -f <per-user directory>/desktop-host/secret-seed && echo written
written
$ ./Shop
ERR_NEED_HOST_VALUE_INVALID: <per-user directory>/desktop-host/secret-seed does not hold 32 bytes of unpadded base64url
$ TELO_HOST_SECRET_SEED=<43 characters, unpadded base64url> ./Shop    # the environment wins; the file is not read

# plain `telo run` of shop/ (section 1) at a terminal, first run
$ telo run ./shop
TELO_HOST_SECRET_SEED is not set — generate one and save it to .env.local? [Y/n] y
saved TELO_HOST_SECRET_SEED to .env.local
root key is 43 characters, password 24
web key is 43 characters
$ telo run ./shop                     # nothing asked; the same key and password

# a plain run of the session application above (Web), at the root of a checkout with telo-workspace.yaml
$ TELO_HOST_SECRET_SEED=<43 characters> telo run --no-input ./apps/web
uploads at /home/me/acme/.telo/state/apps/web/_/needs/uploads, key 43 characters

$ telo run --no-input ./shop          # CI, no seed
ERR_NEED_UNMET: need 'sessionKey' (Telo.GeneratedSecretKey, declared by ./) has no value; set TELO_HOST_SECRET_SEED, or TELO_NEED_SESSION_KEY__KEY
```

```yaml
# k8s chart values, PostgreSQL store: replicas share one operator-supplied seed
sessionStore: { kind: postgres, existingSecret: telo-runner-db }
secretSeed: { existingSecret: telo-runner-seed }
```

**Verify.**
- Two applications in one session that each declare `sessionKey` read different values, two that each declare `uploads` get different directories, and neither refuses with `ERR_NEED_ORPHANED`; a child `admin` of `web` sits at `apps/web/apps/admin/` and nothing else in the session is named `apps`.
- A SQLite runner (host, docker, k8s with its state claim) started with no variable boots, writes `secret-seed` at `0600`, and gives a session app the same secret after a restart and after suspend and resume; two PostgreSQL replicas sharing `RUNNER_SECRET_SEED` give one session the same secret, and without it the runner warns at startup and a session application declaring either generated type gets `ERR_NEED_UNMET`; renaming `web` changes its directory and secret, a deleted session leaves no storage.
- A malformed variable and a truncated `secret-seed` each refuse without printing the value, and the file is left untouched.
- The k8s pod spec is unchanged by adding or removing an application, holds no seed, and the runner's RBAC is unchanged.
- A packaged app declaring `sessionKey` starts with an empty environment and keeps its value across relaunches; deleting `desktop-host/secret-seed` changes it, truncating it refuses the start naming the file; `TELO_HOST_SECRET_SEED` in an env file wins; a second start that finds the lock held writes nothing.
- With nothing naming `TELO_HOST_STATE_DIR`, a plain `telo run` (`--no-input` included) answers every durable directory beneath `<workspace dir>/.telo/state/<app dir>/_`, asks for no path, and gives the same directory on the next run from any working directory; two applications of one workspace that each declare `uploads` get different directories and neither reports an orphan; an env file naming `TELO_HOST_STATE_DIR` wins; a packaged non-desktop app and a remote entry anchor at the working directory.
- The cache lands in `<workspace dir>/.telo/cache` in both kernels, `TELO_CACHE_DIR` still wins, and nothing is written directly under `.telo/` but `cache/` and `state/`.
- `telo run` at a terminal with no seed asks the one question and never a generated need's field; Yes appends exactly one `TELO_HOST_SECRET_SEED=` line to the sensitive env file, and the next run asks nothing and reads the same values; No ends in `ERR_NEED_UNMET`; an unwritable file refuses the run naming it, printing no value; `--no-input` asks nothing and writes nothing; an app with no generated need, or whose generated needs all have env values, is never asked.
- `@telorun/secret-seed`'s vectors (a valid seed, wrong length, padded, wrong alphabet, a child derivation for a fixed seed and label) pass; `pnpm run check:licenses` passes with the kernel, runner-core and the CLI depending on it, runner-core depends on neither `@telorun/kernel` nor `@telorun/sdk`, and no package but it creates a `secret-seed` file or decodes a seed.

**Docs / release.** `packages/secret-seed` README (the normative read-or-create and derivation) and its `LICENSE`, its entry in `pnpm run check:licenses`' MIT list, the root `README.md` and root `CLAUDE.md` Monorepo Structure, a `release.units` entry in `telo-workspace.yaml`; `packages/runner-core` (stating the per-application label), docker-runner, k8s-runner and host-runner guides and READMEs, the k8s chart's values, stating the derivation and the one-root-per-host-value-set contract for any other host (a set of host values serves exactly one root application; replicas of it agree by sharing them); `kernel/specs/desktop-host.md` §5.2 (`desktop-host/secret-seed` among the files only the lock holder touches, pointing at the package README for the read-or-create rule), `docs/guides/providing-needs.md#desktop-hosts` (and the terminal offer beside the generated types), `docs/guides/packaging-an-app.md`, `kernel/specs/application-arguments.md` §4.1 (a generated need's fields are never asked for; the generable host-value entry in their place); `docs/guides/providing-needs.md#durable-directories` (the `telo run` default), and every doc, spec, test and guide naming the cache's old subdirectories (`.telo/manifests`, `.telo/analysis`, …) or clearing the cache by deleting `.telo` — root `CLAUDE.md`, the kernel and CLI guides among them; release fragments for `packages/secret-seed`, kernel, runner-core, docker-runner, k8s-runner, host-runner and cli.
