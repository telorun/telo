---
status: approved
priority: high
depends-on: []
packages: [analyzer, kernel, templating, cli, packages/runner-core, apps/docker-runner, apps/k8s-runner, apps/authoring-agent, starters, examples]
---

# Host values and tagged defaults — remaining work

Merges what is left of the host-needs work and the host-path follow-ups. Shipped and not repeated here: `Telo.DurableDirectory` with `TELO_HOST_STATE_DIR` and its checks, `Telo.PublicUrl` / `Telo.PublicHostPattern` with the public URL templates and the k8s runner's routing of them, `App.Instance` `needs:`, the PostgreSQL `DatabaseAccess` need type, and `Telo.HostPath`'s `entry`.

Order: 1, 2, 3, 4 in that order; 5 and 6 whenever; 7 after 1 has released.

---

## 1. A module-file tag as a kind schema `default:`

**Today.** `schema: { properties: { root: { x-telo-type: Telo.HostPath, default: !module-path ./public } } }` is never resolved. The kernel fills defaults only into AJV's throwaway validation copy, where the raw marker object then fails the node — a consumer omitting `root` dies at boot with `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` on its own resource, while `telo check` (whose AJV fills nothing) is silent. A template kind's `self` gets the unresolved marker after resolution already ran. Publish and `MODULE_PATH_NOT_FOUND` already claim and check the file, for a value nothing reads.

**Decision.** Supported. A `!module-path` / `!include-text` / `!include-bytes` written as a kind-schema `default:` names a file of the module that wrote that default.

- **One fill site for every kind.** The kernel fills every declared schema default into the resource at the START of creation — over the inheritance-resolved author schema, including the config a `base:` mapping hands the inherited controller — before literal decoding and tag resolution, so a default goes through exactly the pipeline a written value does. The template controller's separate `self` fill is removed. A code controller now receives plain defaults too. A filled default never reads as an edit in the reconcile diff. The fill's reach mirrors AJV's: `properties` and `items` at any depth, following local `$ref`, not inside compound keywords — ONE shared reader of default-bearing positions (extending the existing contract-default walk) serves the kernel fill, the analyzer's filled validation and both refusals below.
- **The tag carries its anchor**, stamped by the loader on every document (`include:` partials anchor to their owner module), so resolution never depends on which context creates the resource: an inherited node of a merge-form child resolves against the ancestor's module, a `base:` child's own field against the child's, a node transplanted by `x-telo-schema-from` against its author's. Templating (Node and Rust) and the Rust kernel follow the same fill-before-resolve and anchor rule.
- **Two refusals:**
  - A scope-resolved tag (`!cel`, `!interpolate`, `!sql`, `!ref`) at a schema default — filled into a consumer, it would evaluate in the consumer's scope.
  - A module-file tag in any schema position the fill does not reach: any keyword other than `default` inside `schema:`; a default under `anyOf` / `oneOf` / `not` / `if` / `then` / `else`; every tag in `status:`, `inputType:` / `outputType:`, `params:` / `returns:`, and a `Telo.JsonSchema` `schema:`. Contract defaults stay excluded: they are filled at dispatch, and module files resolve only at creation.

**Diagnostics.**

| Code | When |
|---|---|
| `DEFAULT_INVALID` | Today reported for a module input's `default:`; extended to every "this `default:` cannot stand as the field's value": a kind-schema default its own node refuses (a tag counts as its engine's produced type, so `!include-bytes` at `type: string` is refused), a scope-resolved tag at a default, and the module-input case. At the declaring doc, entry-module-scoped. |
| `MODULE_PATH_OUTSIDE_RESOURCE` / `INCLUDE_OUTSIDE_RESOURCE` | extended to the unreached schema positions above; not entry-scoped (the kernel refuses a dependency's too) |
| `HOST_PATH_RELATIVE` | at a kind default, message and `DiagnosticFix` also offer `!module-path <path>` ("a file this module ships") beside "drop it and make the field required" |
| `SCHEMA_VIOLATION` | at a consumer, computed over the value with defaults filled (a tag standing in as its produced type); the message names the kind whose default supplied the value |
| `ERR_DEFAULT_INVALID` | at definition registration, for a scope-resolved tag at a default |
| `ERR_MODULE_PATH_OUTSIDE_RESOURCE` / `ERR_INCLUDE_OUTSIDE_RESOURCE` | at registration, for the unreached positions |

Resolution failures keep `ERR_MODULE_PATH_NOT_FOUND` / `ERR_INCLUDE_FILE_NOT_FOUND`, with the message naming the declaring kind. No `requires:` floor — every token is existing vocabulary (confirm by verify 6).

**Verify.**
1. A library kind declares `root` (`Telo.HostPath`, `default: !module-path ./public`); a consumer in another directory omits `root` → `telo check` clean, and at run the controller receives the absolute path of the LIBRARY's `public/`. From `oci://`, the `assets` layer is fetched only when that resource is created.
2. A merge-form child in a third module inherits the node and gets the library's path; a template kind reading `self.root.joinPath('index.html')` gets a string.
3. `default: !include-bytes ./x` at a string node → `DEFAULT_INVALID` at the kind; a consumer omitting the field → `SCHEMA_VIOLATION` in check, `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` at run.
4. `default: !cel "variables.x"`, and an `!include-text` inside an `inputType:` default, are refused at both ends, including from a dependency.
5. A code controller whose kind declares plain defaults receives them.
6. The previous published CLI's `check` on a module carrying a tagged default reports nothing (the basis for "no floor").
7. `tests/check-run-agreement.yaml` pins `ERR_DEFAULT_INVALID`, `ERR_MODULE_PATH_OUTSIDE_RESOURCE` and the module-input `DEFAULT_INVALID` ↔ `ERR_MANIFEST_VALIDATION_FAILED` pair, each at a library plus a silent consumer with `runFails:`.

**Docs / release.** Root `CLAUDE.md` (Host paths and module files), analyzer guide (defaults are filled by the kernel for every kind, not by `self`), templating guide, `docs/reference/diagnostics.md` (`DEFAULT_INVALID` row widened, new codes), `docs/guides/embedding-files.md`, authoring-agent primer. Changesets for analyzer, templating, kernel.

---

## 2. `Telo.GeneratedSecret`

**Today.** No such type, no `TELO_HOST_SECRET_SEED`, no secret markers. A secret a module needs is supplied by an env name or not at all; the kernel strips only the public URL templates and `TELO_HOST_STATE_DIR` from the workload and from a started child.

**Decision.** A kernel-declared need type answered from a host value, like `Telo.DurableDirectory`.

- **Type.** Parameter `bytes` (default 32). Field `value`, sensitive: the bytes as base64url text.
- **Answer.** `TELO_HOST_SECRET_SEED` (32 bytes, base64url): HKDF-SHA256 over the seed with the need path as `info`. A pure function of seed and path — the same seed gives the same secret on every restart, reload and resume, with nothing stored. Two needs differ.
- **Precedence.** Unchanged: a `needs:` supply at an import, then the field's env name, then the host value. With none, `ERR_NEED_UNMET` naming `TELO_NEED_<PATH>__VALUE`.
- **Markers.** When `TELO_HOST_STATE_DIR` is set, the kernel writes an empty marker at `<state dir>/secrets/<need path>` for each secret it answers from the seed. The marker holds no secret material.
- **Orphans.** At load, a marker under `<state dir>/secrets/` that no declared path names is an orphan, handled exactly as durable-directory orphans are: `ERR_NEED_ORPHANED` before any resource initializes when the load would create a fresh marker while one exists, otherwise a `NEED_ORPHANED` warning; nothing moved or deleted. The repair is to rename the need back, or to delete the orphan marker and accept a new value.
- **Bad seed.** A seed that does not decode to 32 bytes is `ERR_NEED_HOST_VALUE_INVALID`, naming the variable, never its value.
- **Hidden.** The seed reads `undefined` from `process.env` and `ctx.env`, and is stripped from the environment a started child inherits, joining the three host values already hidden. `TELO_HOST_CONTAINER_ENGINE_*` still reaches children.
- **Report.** `telo needs report` lists the type like any other, parameters with defaults filled, naming the env name a host may set instead.

**Verify.**
- With the seed set, a secret reads the same value across restarts and differs between two needs. With it unset, `ERR_NEED_UNMET` naming `TELO_NEED_<PATH>__VALUE`.
- With `TELO_HOST_STATE_DIR` set, renaming `sessionKey` is `ERR_NEED_ORPHANED` naming `secrets/sessionKey` and the new path; deleting the marker boots with a new value; renaming back boots with the old one. No file under the state directory holds a derived secret.
- Under a parent with host values set, an `App.Instance` child declaring `sessionKey`, with nothing supplying it, is `ERR_NEED_UNMET`; supplied `needs: { sessionKey: !ref workerKey }` it reads a value other than the parent's, and the parent's state directory gains nothing. A controller reading `process.env.TELO_HOST_SECRET_SEED` gets `undefined`.
- A seed of the wrong length or alphabet is `ERR_NEED_HOST_VALUE_INVALID`, and the output never contains the seed.

**Docs / release.** Root `CLAUDE.md`, analyzer and kernel guides, `docs/guides/providing-needs.md`, `docs/reference/diagnostics.md` and `environment-variables.md`, the authoring-agent primer. Changesets for analyzer, kernel, cli. Modules adopting the type declare `requires: telo:` at the release carrying it.

---

## 3. Runners

**Today.** The k8s runner sets the public URL templates and routes the `publicUrls` hosts. Neither runner gives an application a state directory or a seed — the only `TELO_HOST_STATE_DIR` a runner sets is the authoring agent's own. A session's application with a `Telo.DurableDirectory` or `Telo.GeneratedSecret` therefore reaches `ERR_NEED_UNMET`.

**Decision.** A runner sets host values on every application container of a session, each application its own. It reads no manifest and no report.

- **Runner-core** mints one seed per session and derives each application's `TELO_HOST_SECRET_SEED` from it once, by HKDF-SHA256 with `telo-host-app/<app name>` as `info`, the app name being the session's own name for that application. The backends only deliver it.
- **Docker runner** mounts a named volume per (session, application) at a fixed path, naming that path in `TELO_HOST_STATE_DIR`.
- **k8s runner:**
  - does the same over a PersistentVolumeClaim per (session, application);
  - delivers the seeds through one Secret per session with one key per application, each referenced from its own container, so no value appears in the pod spec;
  - gains the RBAC verbs on Secrets and PersistentVolumeClaims this needs.
- **Local-process backend** gives `TELO_HOST_STATE_DIR` a directory it owns per (session, application).
- **Isolation.** No application sees another's state, so each orphan scan covers only its own application's entries.
- **Retention.** The session seed is retained with the session's launch, as its tokens are, so resume and a changed app set keep every application's values. Renaming an application gives it new ones. Volumes outlive suspension.
- **Removal.** Deleting the session removes its volumes and its seed; removing an application removes its volume. The boot-time reaping of orphaned workloads removes the volumes of sessions that are gone.
- **Docs.** The runner docs state the one-root-per-host-value-set contract for any other host (a set of host values serves exactly one root application; replicas of it agree by sharing them), plus the address derivation and `publicUrls` routing if not already stated.
- **Other need types** in a session come from the session's `env`; a missing one starts and the kernel refuses with `ERR_NEED_UNMET` naming the env names.

**Verify.**
- Two applications in one session that each declare `sessionKey` read different values, two that each declare `uploads` get different directories, and neither refuses with `ERR_NEED_ORPHANED`.
- A suspended and resumed session, and a restarted pod, return the same secret and the same directory contents. A deleted session leaves no volume.
- On a routed k8s session no seed or fulfilled value appears in the pod spec.

**Docs / release.** `packages/runner-core`, docker-runner and k8s-runner guides and READMEs; changesets for each package touched.

---

## 4. The Rust kernel

Supporting needs is env reads and local derivation, so it needs no network client. It is an ordinary parity slice: the kernel-declared types (durable directory, public URL, generated secret), `needs:` at an import and on `App.Instance`, and the Rust SDK's two need operations. Today it refuses `needs:`, an import's `needs:` and `Telo.NeedType` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`. Taken through the `rust-parity` skill, not here by hand.

---

## 5. Starters and examples pin older modules

**Today.** Every starter and example pins `oci://ghcr.io/telorun/http-server@0.41.1` (30 files) and `oci://ghcr.io/telorun/sqlite@0.12.0` (26), while the repo's modules are at 0.41.2 and 0.12.1. Most example variables already carry `entry`; a pin on a version without the host-path schema protects nothing on the consuming side.

**Decision.** Bump every `http-server` and `sqlite` pin in `starters/` and `examples/` to the newest published version with `telo upgrade` (rewrites the pin and its digest, checks the `requires:` range), and add the `entry` argument to any variable feeding those slots that lacks it, in the same change. Do it after item 1 releases if that release republishes either module.

**Verify.** `telo check` over each starter and example is clean; `starters/test-suite.yaml` and `examples/test-suite.yaml` pass; replacing a starter's `dbFile` wiring with `!cel "string(variables.dbFile)"` reports `HOST_PATH_UNTYPED_SOURCE`.

---

## 6. Other backing services

Every stdlib module with a backing service follows the PostgreSQL pattern as it is touched: the module that opens the connection exports the need type and a slot referencing it. Only `postgres` does today. No task of its own.

---

## 7. Verification still owed from the shipped work

Unconfirmed in this review; run once and fix what fails:
- With `DATABASE_URL` pointing at PostgreSQL 14, an application needing `>=15.0.0` is refused at the connection's init with `ERR_NEED_UNMET`, naming `DATABASE_URL`, 14 and the range; a server without `pgvector` refuses a need listing it; an unreachable address is a connection error, never `ERR_NEED_UNMET`.
- The studio's reference picker offers a need at `access` with no kind-specific code.
- An integration test supplying a self-supplied `Postgres.DatabaseAccess` over the suite's database to an `App.Instance` passes.

## Refusals added

| Code | When |
|---|---|
| `ERR_NEED_HOST_VALUE_INVALID` (extended) | a `TELO_HOST_SECRET_SEED` that does not decode |
| `ERR_NEED_ORPHANED` / `NEED_ORPHANED` (extended) | a marker under `secrets/` that no declared path names |
| the table in item 1 | tagged defaults |
