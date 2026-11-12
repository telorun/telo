---
status: approved
priority: high
depends-on: []
packages: [analyzer, kernel, sdk, cli, packages/runner-core, apps/docker-runner, apps/k8s-runner, apps/authoring-agent]
refinement: not-ready
---

# Host values — remaining work

Order: 1, then 2. The state-directory half of 2 does not depend on 1 and may ship first.

---

## 1. `Telo.GeneratedSecret`

**Today.** No such type, no `TELO_HOST_SECRET_SEED`. A secret a module needs is supplied by an env name or not at all; the kernel strips only the public URL templates and `TELO_HOST_STATE_DIR` from the workload and from a started child.

**Decision.** A kernel-declared need type answered from a host value, like `Telo.DurableDirectory`.

- **Type.** No parameters. Field `value`, sensitive: 32 bytes as unpadded base64url text (43 characters), usable as a string wherever a secret string is taken.
- **Answer.** `TELO_HOST_SECRET_SEED` (32 bytes, unpadded base64url): HKDF-SHA256 over the seed, empty salt, `info` = `telo/generated-secret/<need path>`. A pure function of seed and path — the same seed gives the same secret on every restart, reload and resume. Two needs differ; two applications differ only if their seeds do, so a seed serves one root application. It is derived rather than stored in the state directory, where it would sit beside the data it protects, in its backups and within reach of any kind that serves the directory.
- **Identity.** A secret's identity is the path of its outermost need. Renaming it, or moving it into a library (its path becomes `<Library>.<need>`), changes the value and reports nothing; keeping the old root need name and forwarding it whole to the library's need keeps the value.
- **Precedence.** A `needs:` supply at an import, then the field's env name, then the host value. With none, `ERR_NEED_UNMET` naming `TELO_HOST_SECRET_SEED` and `TELO_NEED_<PATH>__VALUE`; a seed that does not decode to 32 bytes is `ERR_NEED_HOST_VALUE_INVALID`, naming the variable, never its value.
- **Child applications.** The seed reads `undefined` from `process.env` and `ctx.env` and is stripped from the environment a started child inherits, with the three host values already hidden. A child declaring the type therefore gets `ERR_NEED_UNMET` unless its instance supplies it through `needs:`. `TELO_HOST_CONTAINER_ENGINE_*` still reaches children.

```yaml
# shop/telo.yaml
kind: Telo.Application
metadata: { name: Shop }
imports:
  Console: oci://ghcr.io/telorun/console@0.19.3
  Jose: oci://ghcr.io/telorun/jose@0.3.1
  App: oci://ghcr.io/telorun/app@0.7.0
needs:
  sessionKey: { kind: Telo.GeneratedSecret }
targets:
  - invoke: { kind: Jose.Encrypt, secret: !cel "resources.sessionKey.value" }
    inputs: { payload: { user: ada } }
  - invoke: { kind: Console.WriteLine }
    inputs:
      output: !interpolate "root key is ${{ size(resources.sessionKey.value) }} characters"
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
  sessionKey: { kind: Telo.GeneratedSecret }
targets:
  - invoke: { kind: Console.WriteLine }
    inputs:
      output: !interpolate "web key is ${{ size(resources.sessionKey.value) }} characters"
```

```
$ telo run ./shop
ERR_NEED_UNMET: need 'sessionKey' (Telo.GeneratedSecret, declared by ./) has no value; set TELO_HOST_SECRET_SEED, or TELO_NEED_SESSION_KEY__VALUE

$ TELO_HOST_SECRET_SEED=short telo run ./shop
ERR_NEED_HOST_VALUE_INVALID: TELO_HOST_SECRET_SEED must be 32 bytes of unpadded base64url

$ TELO_HOST_SECRET_SEED=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d =) telo run ./shop
root key is 43 characters
web key is 43 characters
```

With the instance's `needs:` line removed, `web` refuses at its start: `ERR_NEED_UNMET: App.Instance 'web': need 'sessionKey' (Telo.GeneratedSecret, declared by ./web) has no value; supply `needs: { sessionKey: … }` on the instance`.

A library's need, and the root forwarding it whole so the value survives the move:

```yaml
# auth/telo.yaml
kind: Telo.Library
metadata: { name: Auth, version: 1.0.0 }
imports:
  Jose: oci://ghcr.io/telorun/jose@0.3.1
needs:
  sessionKey: { kind: Telo.GeneratedSecret }
exports: { resources: [seal] }
---
kind: Jose.Encrypt
metadata: { name: seal }
secret: !cel "resources.sessionKey.value"
```

```yaml
# shop/telo.yaml
kind: Telo.Application
metadata: { name: Shop }
imports:
  Auth: { source: ../auth, needs: { sessionKey: !ref sessionKey } }
needs:
  sessionKey: { kind: Telo.GeneratedSecret }
targets:
  - invoke: !ref Auth.seal
    inputs: { payload: { user: ada } }
```

**Verify.**
- With the seed set, a secret reads the same value across restarts and differs between two needs; with a fixed seed it equals the expected value pinned in a manifest test, which the Rust kernel's parity slice must meet. With the seed unset, `ERR_NEED_UNMET` naming `TELO_HOST_SECRET_SEED` and `TELO_NEED_<PATH>__VALUE`. A seed of the wrong length or alphabet is `ERR_NEED_HOST_VALUE_INVALID`, and the output never contains it.
- Renaming `sessionKey` boots with a new value and reports nothing; forwarding the renamed library need from a root need still named `sessionKey` keeps the old value. Nothing is written under the state directory.
- A child instance without `needs:` for its secret refuses at its start; with it, the child reads the parent's value. A controller reading `process.env.TELO_HOST_SECRET_SEED` gets `undefined`, in the parent and in a child.

**Docs / release.** Root `CLAUDE.md`, analyzer and kernel guides, `docs/guides/providing-needs.md` (the identity rule, and that two applications under one seed share a key for one need path), `docs/reference/diagnostics.md` and `environment-variables.md`, the authoring-agent primer, `docs/guides/what-you-get.md` (generated secrets a host never stores). Changesets for analyzer, kernel, sdk, cli. A module adopting the type takes its floor from `telo release floor`. The Rust kernel gets the type through the `rust-parity` skill, not here.

---

## 2. Runners and the desktop host

**Today.** The k8s runner sets the public URL templates and routes the `publicUrls` hosts. Neither runner gives an application a state directory or a seed — the only `TELO_HOST_STATE_DIR` a runner sets is the authoring agent's own. A session's application with a `Telo.DurableDirectory` or `Telo.GeneratedSecret` therefore reaches `ERR_NEED_UNMET`. The desktop host gives an app a per-user directory (`TELO_HOST_STATE_DIR` beneath it) but no seed, so a packaged app declaring `Telo.GeneratedSecret` fails for an end user who cannot set environment variables.

**Decision.** One rule for every host: a host whose durable state root has a single writer generates 32 random bytes once into a `secret-seed` file there (exclusive create, mode `0600`, holding the seed as unpadded base64url) and reads it from then on; a host whose records are shared takes the seed from its operator; a value the environment supplies always wins; a value or file that does not decode to 32 bytes refuses, naming the variable or the file and never its contents, and the file is never regenerated. The read-or-create is implemented once, exported by runner-core from an entry that loads no server code, and called by core and by the CLI's desktop host.

- **Runners.** Runner-core delivers `TELO_HOST_STATE_DIR` and `TELO_HOST_SECRET_SEED` in the environment of every Run of a session's application, each application its own, overwriting any client-supplied value of either, as it already does for the container-engine values. The runner reads no manifest and no report.
- **Runner root seed.** `RUNNER_SECRET_SEED` (32 bytes, unpadded base64url) when set. Unset with the SQLite session store (the default), core keeps it in `<RUNNER_STATE_DIR>/secret-seed`, beside `sessions.sqlite`. Unset with the PostgreSQL store, no seed is delivered, the runner logs one startup warning naming `RUNNER_SECRET_SEED`, and a session application declaring the type gets `ERR_NEED_UNMET`; replicas share records but not a state directory, so only an operator-supplied value can agree. Setting `RUNNER_SECRET_SEED` later, deleting `secret-seed` or rotating the variable rotates every session's secrets. The k8s chart takes it from a Secret reference (`secretSeed.existingSecret`). The local-process backend strips `RUNNER_SECRET_SEED` from every process it spawns.
- **Per-application seed.** Core derives each application's seed per Run by HKDF-SHA256 over the root seed, empty salt, `info` = `telo/secret-seed/<session id>/<app name>`. Nothing is stored beside the root, so a second replica sharing it, a restart, a suspend and a resume all give the same value.
- **State.** Each application's state directory is `apps/<app name>/` of the session's existing storage — the session directory on the docker runner's bundle volume, the session's PersistentVolumeClaim on k8s, a directory of the session on the local-process backend — and its kernel `needs/` and `apps/<path>` sit beneath it. The k8s pod stays independent of the app set (its init container creates `apps/`, mounted once into the `apps` container). The docker runner mounts it into `app-<name>` through a volume subpath at `/var/lib/telo-apps/<app name>`, and the k8s `apps` container mounts the claim's `apps/` once at `/var/lib/telo-apps`, so `TELO_HOST_STATE_DIR` reads the same on both. An application is identified by its name in the session: renaming one gives a new directory and new secrets.
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
  sessionKey: { kind: Telo.GeneratedSecret }
targets:
  - invoke: { kind: Console.WriteLine }
    inputs:
      output: !interpolate "uploads at ${{ string(resources.uploads.path) }}, key ${{ size(resources.sessionKey.value) }} characters"
```

Before — a Run of `web` in session `s1`:

```
ERR_NEED_UNMET: need 'uploads' (Telo.DurableDirectory, declared by ./) has no value; set TELO_NEED_UPLOADS__PATH
```

After:

```
# SQLite store (the default): nothing to set
$ telo runner --state-dir ./runner-state
$ ls -l ./runner-state
sessions.sqlite
secret-seed            # mode 0600

# a Run of `web` in session s1 receives, beside the session's own env
TELO_HOST_STATE_DIR=/var/lib/telo-apps/web
TELO_HOST_SECRET_SEED=<43 characters, unpadded base64url>

# the application prints
uploads at /var/lib/telo-apps/web/needs/uploads, key 43 characters

$ RUNNER_SECRET_SEED=short telo runner --state-dir ./runner-state
telo runner: RUNNER_SECRET_SEED must be 32 bytes of unpadded base64url

$ telo runner --state-dir ./runner-state      # secret-seed truncated
telo runner: ./runner-state/secret-seed does not hold 32 bytes of unpadded base64url

# the desktop host: first start of a packaged Shop, then a truncated file
$ ./Shop
$ test -f <per-user directory>/desktop-host/secret-seed && echo written
written
$ ./Shop
ERR_NEED_HOST_VALUE_INVALID: <per-user directory>/desktop-host/secret-seed does not hold 32 bytes of unpadded base64url
$ TELO_HOST_SECRET_SEED=<43 characters, unpadded base64url> ./Shop    # the environment wins; the file is not read
```

```yaml
# k8s chart values, PostgreSQL store: replicas share one operator-supplied seed
sessionStore: { kind: postgres, existingSecret: telo-runner-db }
secretSeed: { existingSecret: telo-runner-seed }
```

**Verify.**
- Two applications in one session that each declare `sessionKey` read different values, two that each declare `uploads` get different directories, and neither refuses with `ERR_NEED_ORPHANED`; a child `admin` of `web` sits at `apps/web/apps/admin/` and nothing else in the session is named `apps`.
- A SQLite runner (local, docker) started with no variable boots, writes `secret-seed` at `0600`, and gives a session app the same secret after a restart and after suspend and resume; two PostgreSQL replicas sharing `RUNNER_SECRET_SEED` give one session the same secret, and without it the runner warns at startup and a session application declaring the type gets `ERR_NEED_UNMET`; renaming `web` changes its directory and secret, a deleted session leaves no storage.
- A malformed variable and a truncated `secret-seed` each refuse without printing the value, and the file is left untouched.
- The k8s pod spec is unchanged by adding or removing an application, holds no seed, and the runner's RBAC is unchanged.
- A packaged app declaring `sessionKey` starts with an empty environment and keeps its value across relaunches; deleting `desktop-host/secret-seed` changes it, truncating it refuses the start naming the file; `TELO_HOST_SECRET_SEED` in an env file wins; a second start that finds the lock held writes nothing.

**Docs / release.** `packages/runner-core`, docker-runner and k8s-runner guides and READMEs, the k8s chart's values, stating the derivation and the one-root-per-host-value-set contract for any other host (a set of host values serves exactly one root application; replicas of it agree by sharing them); `kernel/specs/desktop-host.md` §5 (`desktop-host/secret-seed` among the files only the lock holder touches, and the whole read-or-create rule — on Windows the per-user directory's inherited ACL in place of mode `0600` — stated normatively so the Rust CLI has one document to implement), `docs/guides/providing-needs.md#desktop-hosts`, `docs/guides/packaging-an-app.md`; changesets for runner-core, docker-runner, k8s-runner and cli.
