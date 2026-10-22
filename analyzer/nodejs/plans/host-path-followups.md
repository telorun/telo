# Host paths, module files and tagged defaults — follow-ups

Handover for the work left after the probe run over the todo starter's `dbFile` / `SQLite.Connection.file` / `Http.Static.root` wiring. Every design question below is decided; each section says what happens today, what must happen instead, and how to verify it.

Order: 2, then 3 last, since it pins releases that carry `entry`.

---

## 2. A module-file tag as a kind schema `default:`

**Today.** `schema: { properties: { root: { x-telo-type: Telo.HostPath, default: !module-path ./public } } }` is never resolved. The kernel fills defaults only into AJV's throwaway validation copy, where the raw marker object then fails the node — so a consumer omitting `root` dies at boot with `ERR_RESOURCE_SCHEMA_VALIDATION_FAILED` on its own resource, while `telo check` (whose AJV fills nothing) is silent. A template kind's `self` gets the unresolved marker after resolution already ran. Publish and `MODULE_PATH_NOT_FOUND` already claim and check the file, for a value nothing reads.

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

Resolution failures keep `ERR_MODULE_PATH_NOT_FOUND` / `ERR_INCLUDE_FILE_NOT_FOUND`, with the message naming the declaring kind. No `requires:` floor — every token is existing vocabulary (confirm by the last verify step).

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

## 3. Starters and examples pin modules that predate host paths

**Today.** Every starter and example pins `oci://ghcr.io/telorun/http-server@0.32.0` and `oci://ghcr.io/telorun/sqlite@0.5.1`, whose `root:` / `file:` are plain strings. Their `x-telo-type: Telo.HostPath` variables and `!module-path` values therefore protect nothing on the consuming side, and every host-path check — `entry` and item 2 — is invisible to them.

**Decision.** Bump every `http-server` and `sqlite` pin in `starters/` and `examples/` to the newest published version, with `telo upgrade` (which rewrites the pin and its digest and checks the `requires:` range). Do it after the release carrying `entry` (`x-telo-type: { name: Telo.HostPath, entry: directory | file }`) is published, so the bump lands on versions carrying it, and add the `entry` argument to the variables feeding those slots in the same change.

**Verify.** `telo check` over each starter and example is clean; `starters/test-suite.yaml` and `examples/test-suite.yaml` pass; replacing a starter's `dbFile` wiring with `!cel "string(variables.dbFile)"` reports `HOST_PATH_UNTYPED_SOURCE` (proof the pinned schema now declares the host path).
