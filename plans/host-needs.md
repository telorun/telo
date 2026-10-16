# Host needs — remaining work

## Kernel-declared types

The kernel answers three types from host values when the environment has not supplied them. A host sets the values it can, and the kernel derives each fulfilment from them locally, so no host needs to read a manifest.

A set of host values serves exactly one root application; a host running several roots gives each its own. A value's identity is the root's host values plus the need path within that root, and replicas of one application agree by sharing them.

| Type | Parameters | Field | Answered from |
|---|---|---|---|
| `Telo.GeneratedSecret` | `bytes` (default 32) | `value`, sensitive: the bytes as base64url text | `TELO_HOST_SECRET_SEED` (32 bytes, base64url): HKDF-SHA256 over the seed with the need path as `info` |
| `Telo.DurableDirectory` | `size`, `access: single-writer \| shared` | `path`, a `Telo.HostPath` | `TELO_HOST_STATE_DIR`: the directory `<state dir>/needs/<need path>`, created at load when absent |
| `Telo.PublicUrl` | `port`, a key of the root's `ports:` | `url`, a `Telo.Url` | `TELO_HOST_PUBLIC_URL_TEMPLATE`: the template with `{port}` replaced by that port's number |

- **Deterministic.** A value is a pure function of the host value and the need path. The same seed, state directory and template give the same secret, directory and URL on every restart, reload and resume, with no value stored.
- **Precedence.** A `needs:` supply at an import comes first, then the field's env name, then the host values.
- **Not enforced.** The kernel does not enforce `size` and `access`; they are listed in the report for whoever provides the storage.
- **Secret markers.** When `TELO_HOST_STATE_DIR` is set, the kernel writes an empty marker at `<state dir>/secrets/<need path>` for each `Telo.GeneratedSecret` it answers from the host values. The marker holds no secret material.
- **Orphans.** Renaming a need, or an importer's alias, gives it a new path, and so a new secret and a new directory. At load, an entry under `<state dir>/needs/` or `<state dir>/secrets/` that no declared path names is an orphan.
  - When the load would create a fresh entry of one type while an orphan of that type exists, it is refused with `ERR_NEED_ORPHANED` before any resource initializes. The refusal names the type and both paths, and notes that the state directory may be shared with another application.
  - The repair for a directory is to move it; for a secret, to rename the need back, or to delete the orphan marker and accept a new value.
  - Otherwise the orphan is a `NEED_ORPHANED` warning. Nothing is moved or deleted automatically.
- **Bad host values.** A host value that does not decode is `ERR_NEED_HOST_VALUE_INVALID`, naming the variable and never printing its value. A template without `{port}` is invalid.
- **Public URL ports.** A library declares `Telo.PublicUrl` without `port`, having no `ports:` of its own; the root declares its own `Telo.PublicUrl` naming a port and forwards it at the import. A `Telo.PublicUrl` reaching the root with no port, a key `ports:` does not hold, or a `udp` port is `NEED_PARAMETERS_INVALID`.
- **Hidden from the workload.** Each of the three host values reads `undefined` from `process.env` and `ctx.env` inside the workload, as a need's env name does.
- **Locally.** The CLI sets no host value. Locally these types are supplied by their env names, or by a user who sets the host values themselves.

## Started applications

- **Supplying a child's needs.** `App.Instance` gains `needs:`, taking the two forms an import's map takes. As with its `variables` / `secrets` / `ports`, a key the child does not declare is refused when it starts (`ERR_MANIFEST_VALIDATION_FAILED`, naming the declared set).
- **No host values.** A child receives none: both kernels strip exactly `TELO_HOST_SECRET_SEED`, `TELO_HOST_STATE_DIR` and `TELO_HOST_PUBLIC_URL_TEMPLATE` from the environment a child inherits, never the whole `TELO_HOST_*` prefix, since `TELO_HOST_CONTAINER_ENGINE_URL` / `_TOKEN` must still reach children. Its kernel-declared needs are therefore supplied through `App.Instance`'s `needs:` from the parent's own needs, or are the child's own `ERR_NEED_UNMET`.
- **A caller acting as host.** A caller passing a host value in an explicit environment acts as that child's host and scopes the values itself.

## Runners

A runner sets host values on every application container of a session, each application its own. It reads no manifest and no report.

- **Runner-core** mints one seed per session and derives each application's `TELO_HOST_SECRET_SEED` from it once, by HKDF-SHA256 with `telo-host-app/<app name>` as `info`, the app name being the session's own name for that application. The backends only deliver it.
- **Docker runner** mounts a named volume per (session, application) at a fixed path, naming that path in `TELO_HOST_STATE_DIR`.
- **k8s runner**:
  - does the same over a PersistentVolumeClaim per (session, application);
  - sets `TELO_HOST_PUBLIC_URL_TEMPLATE` when the session is routed (`https://{port}-<session id>.<base domain>`);
  - delivers the seeds through one Secret per session with one key per application, each referenced from its own container, so no value appears in the pod spec;
  - gains the RBAC verbs on Secrets and PersistentVolumeClaims this needs.
- **Local-process runner backend** gives `TELO_HOST_STATE_DIR` a directory it owns per (session, application).
- **Isolation.** No application can see another's state, so each orphan scan covers only its own application's entries.
- **Retention.** The session seed is retained with the session's launch, as its tokens are, so resume and a changed app set keep every application's values. Renaming an application gives it new ones. The volumes outlive suspension.
- **Removal.** Deleting the session removes its volumes and its seed; removing an application from the session removes its volume. A runner's boot-time reaping of orphaned workloads removes the volumes of sessions that are gone, as a runner restart already loses those sessions.
- **The host-value contract.** The runner docs state the one-root-per-host-value-set contract for any other host, Telo Cloud included.
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
| `NEED_PARAMETERS_INVALID` | (existing) also a `Telo.PublicUrl` at the root naming no port, a key `ports:` does not hold, or a `udp` port |
| `ERR_NEED_HOST_VALUE_INVALID` | a host value that does not decode |
| `ERR_NEED_ORPHANED` / `NEED_ORPHANED` | an orphan under the state directory's `needs/` or `secrets/` when a fresh entry of that type would be created; a warning otherwise |

## Order of work

Every module adopting new surface declares a `requires: telo:` floor on the same change.

1. **Started applications and kernel-declared types**: `App.Instance` `needs:`, host-value stripping, the three types, markers and the orphan refusal.
2. **Runners**: per-application seeds, volumes, the public URL template, and removal.
3. **Docs, for each step**: the guides, the module docs of `app`, the runner docs for the host values and the one-root-per-host-value-set contract, and the authoring-agent primer.

## Verify

- **Version and features on a real server.** With `DATABASE_URL` pointing at PostgreSQL 14, an application needing `>=15.0.0` is refused at the connection's init with `ERR_NEED_UNMET`, naming `DATABASE_URL`, 14 and the range. A server without `pgvector` refuses a need listing it. An unreachable address fails as a connection error, never as `ERR_NEED_UNMET`.
- **Studio.** The studio's reference picker offers the need at `access`, with no kind-specific code.
- **Generated secret.** With `TELO_HOST_SECRET_SEED` set, a `Telo.GeneratedSecret` reads the same value across restarts and differs between two needs. With the seed unset, the need is `ERR_NEED_UNMET` naming `TELO_NEED_<PATH>__VALUE`.
- **Durable directory.** With `TELO_HOST_STATE_DIR` set, a `Telo.DurableDirectory` keeps a file across restarts. After renaming its import alias, the next run is refused with `ERR_NEED_ORPHANED` naming both paths, and boots on the same file after the directory is moved.
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
port: !cel "ports.http"
baseUrl: !cel "string(resources.publicUrl.url)"
mounts:
  - path: /
    mount: !ref api
```

- **On a routed k8s runner session**, all three are answered with no configuration:
  - `sessionKey` from the application's `TELO_HOST_SECRET_SEED` and the path `sessionKey`;
  - `uploads` as `<TELO_HOST_STATE_DIR>/needs/uploads` on the application's volume;
  - `publicUrl` from `TELO_HOST_PUBLIC_URL_TEMPLATE` with `{port}` replaced by 8080.

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
