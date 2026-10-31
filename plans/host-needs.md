# Host needs — remaining work

## Kernel-declared types

The kernel answers three types from host values when the environment has not supplied them. A host sets the values it can, and the kernel derives each fulfilment from them locally, so no host needs to read a manifest.

A set of host values serves exactly one root application; a host running several roots gives each its own. A value's identity is the root's host values plus the need path within that root, and replicas of one application agree by sharing them.

| Type | Parameters | Field | Answered from |
|---|---|---|---|
| `Telo.GeneratedSecret` | `bytes` (default 32) | `value`, sensitive: the bytes as base64url text | `TELO_HOST_SECRET_SEED` (32 bytes, base64url): HKDF-SHA256 over the seed with the need path as `info` |
| `Telo.DurableDirectory` | `size` (default `1Gi`); `access: single-writer \| shared` (default `single-writer`) — see Durable directories | `path`, a `Telo.HostPath` with `entry: directory` | `TELO_HOST_STATE_DIR`: the directory `<state dir>/needs/<need path>`, created at load when absent. A host that provides storage per need supplies the field's env name instead (see Durable directories) |
| `Telo.PublicUrl` | `port`, a key of the root's `ports:`; `primary` and `customDomains`, booleans (default `false`) | `url`, a `Telo.Url` | `TELO_HOST_PUBLIC_URL_TEMPLATE` and `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE`: the address derived from them (see Public URLs) |

- **Deterministic.** A value is a pure function of the host value and the need path. The same seed, state directory and template give the same secret, directory and URL on every restart, reload and resume, with no value stored.
- **Precedence.** A `needs:` supply at an import comes first, then the field's env name, then the host values.
- **Not enforced.** The kernel does not enforce `size` and `access`; they are listed in the report for whoever provides the storage.
- **Defaults in the report.** `telo needs report` lists every need's `parameters` with its type's schema defaults filled in, for every need type, so a host reads `size: 1Gi` and `access: single-writer` from a need that wrote neither and never reimplements a type's defaults.
- **Secret markers.** When `TELO_HOST_STATE_DIR` is set, the kernel writes an empty marker at `<state dir>/secrets/<need path>` for each `Telo.GeneratedSecret` it answers from the host values. The marker holds no secret material.
- **Orphans.** Renaming a need, or an importer's alias, gives it a new path, and so a new secret and a new directory. At load, an entry under `<state dir>/needs/` or `<state dir>/secrets/` that no declared path names is an orphan.
  - When the load would create a fresh entry of one type while an orphan of that type exists, it is refused with `ERR_NEED_ORPHANED` before any resource initializes. The refusal names the type and both paths, and notes that the state directory may be shared with another application.
  - The repair for a directory is to move it; for a secret, to rename the need back, or to delete the orphan marker and accept a new value.
  - Otherwise the orphan is a `NEED_ORPHANED` warning. Nothing is moved or deleted automatically.
- **Bad host values.** A host value that does not decode is `ERR_NEED_HOST_VALUE_INVALID`, naming the variable and never printing its value. The two public URL templates are validated as `plans/2026-10-17-public-urls.md` states.
- **Public URL parameters.** A library declares `Telo.PublicUrl` with none of `port`, `primary` and `customDomains`, having no `ports:` of its own; the root declares its own `Telo.PublicUrl` naming a port and forwards it at the import. The full rules are in Public URLs.
- **Hidden from the workload.** Each of the four host values reads `undefined` from `process.env` and `ctx.env` inside the workload, as a need's env name does.
- **Locally.** The CLI sets no host value. Locally these types are supplied by their env names, or by a user who sets the host values themselves.

## Durable directories

What an application may rely on from a `Telo.DurableDirectory`, and what a host providing one must give. The type's own `description` says the same, and so do the docs.

- **`size`.** A whole number followed by `Mi`, `Gi` or `Ti` (`512Mi`, `5Gi`, `1Ti`), checked by the type's `parameters` schema (`NEED_PARAMETERS_INVALID`); default `1Gi`. It is the least the application needs: a host may give more and may refuse a size it cannot give. The kernel never measures it. A full directory reaches the application as the operating system's own error (`ENOSPC`).
- **`access`.** Default `single-writer`.
  - `single-writer`: at most one running instance of the application has the directory at any moment, a rollout or a restart included. A host never runs two at once over it, and the application may rely on that (SQLite does).
  - `shared`: every instance has the directory at once, on different machines. File locking across them is not reliable, so the application coordinates its own writes. SQLite is not safe here. The SQLite module's docs and the type's description say so.
- **What persists.** The contents survive restarts, reloads, new deployments and new versions of the application, for as long as the host keeps the storage. The directory is empty the first time. Nothing here is a backup.
- **Supplied per need.** A host that provides storage per need — each its own volume, with its own size and access — mounts each one and sets that need's `path` env name to the mount: the name the report lists for the field, bound (`env:`) or derived (`TELO_NEED_UPLOADS__PATH`). It sets no `TELO_HOST_STATE_DIR`. This is the env-name step of the precedence above, so no other mechanism is involved, and it reads the report, never the manifest.
- **Renames under per-need supply.** A renamed need gets a new path and a new env name, so the host sees a need it has no storage for and an old one no version declares. Recovering the old storage under the new name is the host's job. The orphan check below covers only `TELO_HOST_STATE_DIR`.
- **Usable at load.** However the path was supplied — import, env name or state directory — the kernel checks at load, before any resource initializes, that it names a directory the process can write to, and creates it when absent. Otherwise the load is refused with `ERR_NEED_DIRECTORY_UNUSABLE`, naming the need path, the env name it came from and what was wrong (not a directory, not writable, cannot be created), never the directory's contents.
- **Forwarding whole.** On top of the forwarding rules for `version:` and `features:`, a `Telo.DurableDirectory` forwarded whole to a library's need is refused with `NEED_FORWARD_INCOMPATIBLE` when:
  - it is `shared` and the target is `single-writer`, since the library's assumption would not hold (`single-writer` into `shared` is allowed);
  - its `size` is smaller than the target's.
- **One directory, one need.** One `Telo.DurableDirectory` — a need or a fulfilment — forwarded whole to two or more needs is refused with `NEED_DIRECTORY_FORWARDED_TWICE`, naming every target, since two libraries would write over each other's files. An application that wants them to share one declares that in one library, not by forwarding.

## Public URLs

`Telo.PublicUrl`, `Telo.PublicHostPattern`, deriving addresses from `TELO_HOST_PUBLIC_URL_TEMPLATE`, `publicUrls` on `Kernel.PortsResolved`, `Http.Server` host routing and the contract every host serving an application's addresses meets are built as `plans/2026-10-17-public-urls.md` states.

## Started applications

- **Supplying a child's needs.** `App.Instance` gains `needs:`, taking the two forms an import's map takes. As with its `variables` / `secrets` / `ports`, a key the child does not declare is refused when it starts (`ERR_MANIFEST_VALIDATION_FAILED`, naming the declared set).
- **No host values.** A child receives none: both kernels strip exactly `TELO_HOST_SECRET_SEED`, `TELO_HOST_STATE_DIR`, `TELO_HOST_PUBLIC_URL_TEMPLATE` and `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` from the environment a child inherits, never the whole `TELO_HOST_*` prefix, since `TELO_HOST_CONTAINER_ENGINE_URL` / `_TOKEN` must still reach children. Its kernel-declared needs are therefore supplied through `App.Instance`'s `needs:` from the parent's own needs, or are the child's own `ERR_NEED_UNMET`.
- **A caller acting as host.** A caller passing a host value in an explicit environment acts as that child's host and scopes the values itself.

## Runners

A runner sets host values on every application container of a session, each application its own. It reads no manifest and no report.

- **Runner-core** mints one seed per session and derives each application's `TELO_HOST_SECRET_SEED` from it once, by HKDF-SHA256 with `telo-host-app/<app name>` as `info`, the app name being the session's own name for that application. The backends only deliver it.
- **Docker runner** mounts a named volume per (session, application) at a fixed path, naming that path in `TELO_HOST_STATE_DIR`.
- **k8s runner**:
  - does the same over a PersistentVolumeClaim per (session, application);
  - sets `TELO_HOST_PUBLIC_URL_TEMPLATE` (`https://{port}-<session id>.<base domain>`) and `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` (`https://{label}--{port}-<session id>.<base domain>`) when a watch session is routed, and the main template alone on a routed one-shot run, which answers each port's primary address only;
  - routes each host of a port's `publicUrls` that ends in `-<session id>.<base domain>`, beside the port's own host: added to the port's HTTPRoute `hostnames`, or as an Ingress rule per host. A host outside the session's suffix is not routed;
  - delivers the seeds through one Secret per session with one key per application, each referenced from its own container, so no value appears in the pod spec;
  - gains the RBAC verbs on Secrets and PersistentVolumeClaims this needs.
- **Local-process runner backend** gives `TELO_HOST_STATE_DIR` a directory it owns per (session, application).
- **Isolation.** No application can see another's state, so each orphan scan covers only its own application's entries.
- **Retention.** The session seed is retained with the session's launch, as its tokens are, so resume and a changed app set keep every application's values. Renaming an application gives it new ones. The volumes outlive suspension.
- **Removal.** Deleting the session removes its volumes and its seed; removing an application from the session removes its volume. A runner's boot-time reaping of orphaned workloads removes the volumes of sessions that are gone, as a runner restart already loses those sessions.
- **The host-value contract.** The runner docs state the one-root-per-host-value-set contract for any other host, and the address derivation and `publicUrls` routing of Public URLs.
- **Other need types.** Every other need type in a session comes from the session's `env`. A session missing one starts, and the kernel refuses with `ERR_NEED_UNMET`, naming the env names to set.

## Other backing services

Every stdlib module with a backing service follows the PostgreSQL pattern as it is touched: the module that opens the connection exports the need type and a slot referencing it.

## The Rust kernel

Supporting needs is env reads and local derivation, so it needs no network client. It is an ordinary parity slice, and it carries the Rust SDK's two need operations.

## Tests

- **Through `App.Instance`.** A test supplies the needs of the application it starts through `App.Instance`'s `needs:`, with literals, a self-supplied fulfilment, or a `!ref` to a need of the test's own.
- **Host values.** Kernel-declared types are tested with tests that set the host values themselves.

## Refusals

| Code | When |
|---|---|
| `ERR_NEED_HOST_VALUE_INVALID` | a host value that does not decode |
| `ERR_NEED_ORPHANED` / `NEED_ORPHANED` | an orphan under the state directory's `needs/` or `secrets/` when a fresh entry of that type would be created; a warning otherwise |
| `ERR_NEED_DIRECTORY_UNUSABLE` | at load, a durable directory's path that is not a directory, is not writable, or cannot be created, however it was supplied |
| `NEED_FORWARD_INCOMPATIBLE` (extended) | a `shared` durable directory forwarded whole to a `single-writer` need, or a smaller `size` forwarded to a larger one |
| `NEED_DIRECTORY_FORWARDED_TWICE` | one durable directory forwarded whole to two or more needs; refused by `telo check` and by the kernel at load, as the other forwarding refusals are |

## Order of work

Every module adopting new surface declares a `requires: telo:` floor on the same change.

1. **Directory entries**: `Telo.HostPath`'s `entry: directory | file` (`plans/host-path-followups.md` §1), first or in the same release as step 2, so the durable directory's `path` declares `entry: directory` and `telo check` refuses wiring it straight into a file slot such as `SQLite.Connection.file` (it needs `.joinPath('app.db')`).
2. **Durable directories**: `Telo.DurableDirectory` alone, released on its own — the type with its parameters and defaults, defaults filled in the needs report, per-need supply through the env name, the load check, the forwarding refusals, `TELO_HOST_STATE_DIR` with its orphan refusal, and hiding and child-stripping of `TELO_HOST_STATE_DIR`. It waits for nothing in steps 3–5. A host relies on the type from the release that ships this step, and Telo Cloud recognises it from that release on.
3. **Started applications and the other kernel-declared types**: `App.Instance` `needs:`, stripping the remaining host values, `Telo.GeneratedSecret`, its markers and its orphan refusal.
4. **Public URLs**: built as `plans/2026-10-17-public-urls.md` states.
5. **Runners**: per-application seeds, volumes, the public URL template, routing the `publicUrls` hosts, and removal.
6. **Docs, for each step**: the guides, the module docs of `app` and `sqlite`, the runner docs for the host values and the one-root-per-host-value-set contract, the per-need supply contract for durable directories, and the authoring-agent primer.

## Verify

- **Version and features on a real server.** With `DATABASE_URL` pointing at PostgreSQL 14, an application needing `>=15.0.0` is refused at the connection's init with `ERR_NEED_UNMET`, naming `DATABASE_URL`, 14 and the range. A server without `pgvector` refuses a need listing it. An unreachable address fails as a connection error, never as `ERR_NEED_UNMET`.
- **Studio.** The studio's reference picker offers the need at `access`, with no kind-specific code.
- **Generated secret.** With `TELO_HOST_SECRET_SEED` set, a `Telo.GeneratedSecret` reads the same value across restarts and differs between two needs. With the seed unset, the need is `ERR_NEED_UNMET` naming `TELO_NEED_<PATH>__VALUE`.
- **Durable directory.** With `TELO_HOST_STATE_DIR` set, a `Telo.DurableDirectory` keeps a file across restarts. After renaming its import alias, the next run is refused with `ERR_NEED_ORPHANED` naming both paths, and boots on the same file after the directory is moved.
- **Durable directory defaults.** `telo needs report -o json` for a need written with no `parameters` lists `size: 1Gi` and `access: single-writer`; `size: 5GB` is `NEED_PARAMETERS_INVALID`.
- **Per-need supply.** With no `TELO_HOST_STATE_DIR` and `TELO_NEED_UPLOADS__PATH` set to a writable directory, the application writes there and keeps the file across restarts; nothing is created under any state directory and no orphan is reported. With it pointing at a regular file, or at a read-only directory, the load is refused with `ERR_NEED_DIRECTORY_UNUSABLE` naming `uploads` and `TELO_NEED_UPLOADS__PATH`, before any resource initializes.
- **Forwarding a directory.** A `shared` need forwarded whole to a library's `single-writer` need, and a `1Gi` one to a `5Gi` one, are each `NEED_FORWARD_INCOMPATIBLE`; `single-writer` into `shared` passes. One need forwarded to two libraries' needs is `NEED_DIRECTORY_FORWARDED_TWICE` from `telo check`, and refused at load by `telo run` with `telo check` skipped.
- **Directory entry.** `resources.uploads.path` wired straight into `SQLite.Connection.file` is `HOST_PATH_ENTRY_MISMATCH`; `resources.uploads.path.joinPath('app.db')` passes.
- **Renamed secret.** With `TELO_HOST_STATE_DIR` set, renaming `sessionKey` is refused with `ERR_NEED_ORPHANED`, naming `secrets/sessionKey` and the new path. Deleting the marker boots with a new value; renaming back boots with the old one. No file under the state directory holds a derived secret.
- **Two applications in one session.** Two applications that each declare `sessionKey` read different values, two that each declare `uploads` get different directories, and neither refuses with `ERR_NEED_ORPHANED`.
- **Child applications.** Under a parent with host values set, an `App.Instance` child declaring `sessionKey`, with nothing supplying it, is refused with `ERR_NEED_UNMET` naming `TELO_NEED_SESSION_KEY__VALUE`. Supplied `needs: { sessionKey: !ref workerKey }`, it reads a value other than the parent's `sessionKey`, and the parent's state directory gains nothing from it. A controller reading `process.env.TELO_HOST_SECRET_SEED` gets `undefined`.
- **Routed k8s session.** A `Telo.PublicUrl` on port `http` reads the session's address for that port, and a watch-session edit adding one boots with the pod unchanged. No fulfilled value or seed appears in the pod spec.
- **Suspend and restart.** A suspended and resumed session, and a restarted pod, return the same generated secret and the same directory contents. A deleted session leaves no volume.
- **Integration test.** An integration test supplying a self-supplied `Postgres.DatabaseAccess` over the suite's database to an `App.Instance` passes against the suite's database.

## Worked example

### A secret, a directory and the public address

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.2.0 }
requires: { telo: ">=0.120.0" }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.29.0
  Fs: oci://ghcr.io/telorun/fs@0.9.4
ports:
  http: { env: PORT, default: 8080 }
needs:
  sessionKey:
    kind: Telo.GeneratedSecret
    parameters: { bytes: 32 }
  uploads:
    kind: Telo.DurableDirectory
    parameters: { size: 5Gi, access: single-writer }
  publicUrl:
    kind: Telo.PublicUrl
    parameters: { port: http }
    env: { url: PUBLIC_URL }
targets:
  - !ref server
---
kind: Fs.File
metadata: { name: uploadFile }
cwd: !cel "resources.uploads.path"
---
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref api
```

- **On a routed k8s runner session**, all three are answered with no configuration:
  - `sessionKey` from the application's `TELO_HOST_SECRET_SEED` and the path `sessionKey`;
  - `uploads` as `<TELO_HOST_STATE_DIR>/needs/uploads` on the application's volume;
  - `publicUrl`, the only `Telo.PublicUrl` and so the primary, from `TELO_HOST_PUBLIC_URL_TEMPLATE` with `{port}` replaced by 8080.

  A suspend and resume, or a restarted pod, returns the same key and the same files.
- **On a docker runner session**, `sessionKey` and `uploads` are answered the same way. `publicUrl` has no host value there, so the session's env must set `PUBLIC_URL`.
- **Under `telo run`**, the run is refused with `ERR_NEED_UNMET` naming `TELO_NEED_SESSION_KEY__VALUE`, `TELO_NEED_UPLOADS__PATH` and `PUBLIC_URL`. A developer sets those, or sets the two host values once:

```
TELO_HOST_SECRET_SEED=<32 bytes, base64url> TELO_HOST_STATE_DIR=./data PUBLIC_URL=http://localhost:8080 telo run ./shop
```

- **Renames.** Renaming `uploads` to `files` refuses the next run with `ERR_NEED_ORPHANED`, naming `./data/needs/uploads` and `./data/needs/files`. Renaming `sessionKey` is refused the same way, naming `./data/secrets/sessionKey`. A key that must survive a rename is bound by `env:` and provided by the operator.

### A test against the suite's database

```yaml
kind: Run.Sequence
metadata: { name: test }
with:
  - kind: App.Instance
    metadata: { name: shop }
    source: ../../telo.yaml
    ports: { http: 8091 }
    needs:
      databaseAccess:
        url:
          scheme: postgres
          host: !cel "resources.Pg.endpoint.status.host"
          port: !cel "resources.Pg.endpoint.status.port"
          user: postgres
          password: postgres
          path: /postgres
targets:
  - !ref shop
```

The child's connection verifies the suite's server against the need's range and features, so a suite database without a required extension fails the test at the child's init with `ERR_NEED_UNMET`.
