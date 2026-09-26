# Host paths, module files and tagged defaults — follow-ups

Handover for the work left after the probe run over the todo starter's `dbFile` / `SQLite.Connection.file` / `Http.Static.root` wiring. Every design question below is decided; each section says what happens today, what must happen instead, and how to verify it.

Order: 1 and 2 (independent of each other), then 3 last, since it pins releases that carry 1.

---

## 1. `Telo.HostPath` says what it names — `entry: directory | file`

**Today.** `root: !module-path ./public/index.html` passes `telo check` (the file exists) and fails or misbehaves only at runtime. Nothing distinguishes a slot that needs a directory from one that needs a file.

**Decision.** `Telo.HostPath` gains one optional type parameter, written `x-telo-type: { name: Telo.HostPath, entry: directory }` or `entry: file`. Omitted means *any* in both directions, so every existing slot and variable keeps working.

- The parameter is found by a FLAG in the value-type data, never by its name: `sdk/value-types/telo-host-path.json` gains `parameters: [{ name: entry, hostEntry: true, description }]`. Both SDK readers (Node and Rust) accept `hostEntry` only on a type declaring `fromHost`, at most one per type. No analyzer or kernel code names `entry`.
- The argument is a TOKEN from a closed vocabulary, `file | directory`, which each runtime maps to its own filesystem query (a runtime that cannot map one fails at startup, the `fromHost` anchor precedent). `directory` means a directory; `file` means anything that is not one; symlinks are followed. Two arguments compare by equality.
- **Existence is not part of the type.** `entry` says what the path names *if something is there*. An absent path passes — SQLite creates its file, the journal creates its directory. `!module-path` keeps requiring existence through its own `MODULE_PATH_NOT_FOUND`.
- The source query `ManifestSource.exists(base, relative) → boolean` is REPLACED by `entryAt(base, relative) → "file" | "directory" | undefined`, in every filesystem-capable source (CLI, kernel, VS Code, studio). A path the module's `sources:` stages counts as `file` when it equals a staged file, `directory` when it sits above one. A source without it records nothing and the kernel's refusal stands.

**Checks.**

| Where | What | Code |
|---|---|---|
| analyzer, reading the annotation | an `entry` value outside the vocabulary (Levenshtein-suggested), wherever `X_TELO_TYPE_ARGUMENT_UNKNOWN` is reported | `X_TELO_TYPE_ARGUMENT_INVALID` |
| loader + analysis | an entry-module `!module-path` whose recorded kind differs from the slot's argument, including a union's host-path branch; entry-module-scoped | `HOST_PATH_ENTRY_MISMATCH` |
| analysis | a plain chain at a host-path field from a variable declaring the other `entry`; an import's `variables:` against the library's host-path inputs (the flattener's stamp now carries each input's `entry`) | `HOST_PATH_ENTRY_MISMATCH` |
| analysis, a step's `inputs:` | the generic comparator | `CEL_TYPE_ARGUMENT_MISMATCH` (existing) |
| kernel, resource creation | a resolved path that exists and is the wrong kind, after `!module-path` and compile-eval resolution; names resource, field, path, found vs declared | `ERR_HOST_PATH_ENTRY_MISMATCH` |
| kernel, `kernel.load()` | an Application variable / secret declaring `entry`; aggregated, naming the variable and its env var | inside `ERR_MANIFEST_VALIDATION_FAILED` |

The filesystem check never goes into the AJV keyword (which must stay synchronous and browser-safe). The Rust kernel enforces `ERR_HOST_PATH_ENTRY_MISMATCH` wherever it resolves a `!module-path`, and its value-type reader accepts the flag — without that it fails at startup on the shared data.

**Stdlib adoption** (each file writes the new object form, so each needs `requires: telo: ">=<TELO_SURFACE_VERSION of the release carrying it>"`, raised from their current floor and verified by execution per the root guide):

- `entry: directory` — `Http.Static.root`; every Fs kind's `cwd`; `DurableJournalFile.Journal.directory`; the approval-app blueprint's `journal`.
- `entry: file` — the host-path branch of `SQLite.Connection.file`; tesseract-model's `data`; the agent-app blueprint's `history`.
- The Application / Library variables feeding those slots in `examples/`, `starters/` and `blueprints/*/example` declare the matching `entry` with the same floor (`dbFile`, `journalDir`, `historyFile`, …).

**Also.** `!module-path` path completion in ide-support offers only directories at a `directory` slot and only files at a `file` slot. `tests/check-run-agreement.yaml` pins a `!module-path` naming a file at a directory slot at a library (`HOST_PATH_ENTRY_MISMATCH`) and from a silent consumer (`runFails:` with `ERR_HOST_PATH_ENTRY_MISMATCH`).

**Verify.**
- `root: !module-path ./public/index.html` → `HOST_PATH_ENTRY_MISMATCH` on that line; `./public` passes.
- The variable feeding an Fs `cwd` pointed at a regular file → boot fails at load with `ERR_HOST_PATH_ENTRY_MISMATCH` naming the env var.
- `SQLite.Connection.file` at a non-existent file boots and creates the database.
- A variable declared `entry: file` wired to `Http.Static.root` is a static error; an unparameterized one is not.
- `npx @telorun/cli@<previous> check modules/http-server/telo.yaml` with `requires:` stripped fails, and with it restored reports `MODULE_REQUIRES_NEWER_RUNTIME`.
- The Rust kernel starts with the updated entry file. Both halves of the agreement suite pass.

**Docs / release.** Root `CLAUDE.md` (Host paths), analyzer and templating guides, `sdk/value-types/README.md`, `docs/reference/diagnostics.md` (three new codes), the five modules' docs, the authoring-agent primer's paths section. Changesets for SDK, analyzer, kernel, CLI; `telo release add` fragments for the five modules and two blueprints.

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

**Today.** Every starter and example pins `oci://ghcr.io/telorun/http-server@0.32.0` and `oci://ghcr.io/telorun/sqlite@0.5.1`, whose `root:` / `file:` are plain strings. Their `x-telo-type: Telo.HostPath` variables and `!module-path` values therefore protect nothing on the consuming side, and every host-path check in items 1 and 2 is invisible to them.

**Decision.** Bump every `http-server` and `sqlite` pin in `starters/` and `examples/` to the newest published version, with `telo upgrade` (which rewrites the pin and its digest and checks the `requires:` range). Do it after item 1 is released, so the bump lands on versions carrying `entry`, and add the `entry` argument to the variables feeding those slots in the same change.

**Verify.** `telo check` over each starter and example is clean; `starters/test-suite.yaml` and `examples/test-suite.yaml` pass; replacing a starter's `dbFile` wiring with `!cel "string(variables.dbFile)"` reports `HOST_PATH_UNTYPED_SOURCE` (proof the pinned schema now declares the host path).
