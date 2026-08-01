---
description: "v1.0 spec: controller loader resolves Package URLs (PURLs) to implementations with type, namespace, version, qualifiers"
---

# Telo Controller Loader Specification (v1.0 Draft)

## Overview

When a `Telo.Definition` resource is initialized, the kernel must locate and load the
controller module that implements that resource kind. Controllers are identified by
**Package URLs (PURLs)** — a standard, registry-agnostic URI format.

The **Controller Loader** resolves a PURL to an executable module and returns a controller
instance. The resolution strategy is defined below and is the same regardless of the host
language or runtime.

---

## 1. Controller PURL Format

A controller PURL follows the [Package URL specification](https://github.com/package-url/purl-spec):

```
pkg:<type>/<namespace>/<name>@<version-spec>[?<qualifiers>][#<entry>]
```

| Component      | Description                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `type`         | Package registry type: `npm`, `cargo`, `golang`, `pypi`, etc.                  |
| `namespace`    | Registry namespace or scope (e.g. `@telorun` for npm, `github.com/org` for Go) |
| `name`         | Package name within the namespace                                              |
| `version-spec` | SemVer constraint (e.g. `>=0.1.0`, `^1.2.0`, `1.0.0`)                          |
| `qualifiers`   | Key-value pairs; see [Section 2](#2-qualifiers)                                |
| `entry`        | Export entry point within the package; see [Section 3](#3-entry-points)        |

A `Telo.Definition` lists one or more PURL candidates. The loader selects the first
candidate whose `type` matches the current runtime (e.g. `npm` for Node.js/Bun).

```yaml
kind: Telo.Definition
metadata:
  name: Server
  module: Http
controllers:
  - pkg:npm/@telorun/http-server@>=0.1.0?local_path=./nodejs#http-server
  - pkg:cargo/telorun-http-server@>=0.1.0?local_path=./rust#http-server
  - pkg:golang/github.com/telorun/http-server@>=0.1.0?local_path=./go#http-server
```

Only one candidate is loaded per initialization — the first one the runtime can handle.

### 1.1 `pkg:telo/local/<format>` — bundled delivery

A controller may instead ship **inside its own module's artifact** rather than being
fetched from an ecosystem registry. This is the direction the standard library has
taken; `pkg:npm` remains supported for third-party modules and for modules whose
dependencies cannot be inlined.

```
pkg:telo/local/<format>?path=<file>[&local_path=<source>][&siblings=<globs>][&os=…&arch=…&libc=…][#<export>]
```

| Segment            | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `type=telo`        | Telo-delivered, not fetched from an ecosystem registry                                      |
| `namespace=local`  | Bundled in the module artifact (reserving `pkg:telo/registry/…` for a fetched controller)   |
| `name=<format>`    | The artifact format the loader dispatches on: `js`, `napi`, `wasm`                          |
| `path`             | The file in the module's payload, relative to `telo.yaml`                                   |
| `#export`          | Named export within it; omit to use the whole module as the controller                      |

Format is explicit because bundling is the one delivery mode not tied to an
ecosystem's runtime (npm ⇒ JS, cargo ⇒ Rust; a bundle is just files). A format
this runtime cannot host is env-missing, so a candidate list falls through to one
it — or another runtime's kernel — can load.

The `path=` entry point is part of the module's payload **because `controllers:`
names it**; it does not have to be restated in `files:`. See the
[module artifact spec](./specs/module-artifact.md) for how candidates partition
into layers, and for the `os`/`arch`/`libc` selector axes.

---

## 2. Qualifiers

### `local_path`

The controller's **source**, relative to the definition file (`Telo.Definition` YAML).
Its meaning is per delivery mode, but the principle is the same in all of them: while
the declaring module is a working copy on disk, the source is what is authoritative,
so the runtime builds from it rather than loading a possibly stale prebuilt artifact.

- **`pkg:npm`** — the local package directory. Resolution stops there; no registry or
  cache is consulted.

  ```
  pkg:npm/@telorun/http-server@>=0.1.0?local_path=./nodejs#http-server
  ```

- **`pkg:cargo`** — the crate directory. The loader runs `cargo build` and loads the
  resulting native addon.

- **`pkg:telo/local/js`** — the TypeScript entry point `path=` was built from. The
  loader bundles it and imports the result, so editing a controller and re-running
  picks the edit up with no build step.

  ```
  pkg:telo/local/js?path=./nodejs/server.mjs&local_path=./nodejs/src/server.ts
  ```

For the bundled mode the gate is the **absence of a module artifact**, not the shape
of the base URI: a published module served from the on-disk manifest cache also has a
local base, and its payload is still its layer. `local_path` is inert in a published
artifact, which ships no sources. It contributes nothing to the layer selector, so it
never affects which layer a host fetches.

---

## 3. Entry Points

The `#entry` fragment selects a named export from the package. It maps to a package export
key of the form `"./<entry>"`.

```
pkg:npm/@telorun/http-server@>=0.1.0#http-server-api
```

resolves the `"./http-server-api"` export key in the package's export map. If no fragment
is given, the package's default export (`.`) is used.

---

## 4. Resolution

### 4.1 Bundled (`pkg:telo/local/<format>`)

Nothing is fetched. The loader picks the candidate this host can run — rejecting a
format it cannot host, and a platform selector it does not match, **before** any
transfer, so a candidate list never downloads every platform on the way to the right
one — and then asks the declaring module's artifact for that selector's layer
directory. A module already on disk resolves `path=` beside its own manifest.

The bundle imports `@telorun/sdk` as a plain bare specifier, but it lives in an
extract directory with no `node_modules` path to it. The loader symlinks the
realm-collapse names into a `node_modules/` beside the bundle, pointing at the
kernel's own copy; standard resolution then finds them on every runtime. That
collapses *identity* as well as resolution, so `Stream` / `InvokeError`
`instanceof` checks hold across the kernel/controller boundary.

When the module is a working copy and `local_path` resolves on disk, the loader
builds the bundle from source instead, caching it under
`<entry-manifest-dir>/.telo/controller-src/`. Each cache entry is named by a digest
covering **every input the build read** plus the build options — so an edit anywhere
in the source graph produces a new entry rather than invalidating one, and two
concurrent kernel processes that race produce identical bytes at identical paths.
Bundles are written through a private temp file and renamed into place, so a reader
sees a whole bundle or none.

A missing file, an unparseable PURL, a non-`local` namespace, an unhostable format
and a non-matching platform are all **env-missing** (fall through to the next
candidate). A bundle that imports but is malformed is a hard `ERR_CONTROLLER_INVALID`,
and a source that fails to build is `ERR_CONTROLLER_BUILD_FAILED` — a real user-code
failure is never masked as env-missing.

### 4.2 npm (`pkg:npm`)

Every controller — registry tag, `file:`, and `local_path` alike — is installed
into a single per-manifest tree rooted at `<entry-manifest-dir>/.telo/npm/`.
A sibling `<entry-manifest-dir>/.telo/manifests/` tree, written by the same
`telo install` pass, holds the YAML of every transitively-imported
`Telo.Library` so boot can resolve manifests without hitting the module
registry. See [Module System](./modules.md#7-manifest-cache) for the cache
layout; this section covers controller resolution only.

```
<entry-manifest-dir>/.telo/npm/
  package.json        # holds @telorun/sdk as a file: dep + overrides pinning it
  .telo-state.json    # hash of the materialized package.json (re-runs short-circuit)
  .lock               # cross-process install lock
  node_modules/
    @telorun/
      sdk/            # symlink → the kernel's own @telorun/sdk realpath
      <controller>/   # one entry per loaded controller package
```

The first load of any kernel materializes the root: writes `package.json`
with `@telorun/sdk` wired in as `file:<kernel-side-resolved-path>` plus an
`overrides` map pinning the SDK to that resolution. npm/pnpm honour `file:`
deps with symlinks; Node's ESM resolver follows them to the same realpath
the kernel itself uses, so the kernel and every controller share one
constructor for `Stream` (and any other class-identity-sensitive type).

Per-controller resolution within that tree:

- `local_path` qualifier present → `npm install file:<resolved-path>` into the
  manifest tree. Loses zero-second hot-reload; gains realm consistency.
- Otherwise → `npm install <name>@<version>` against the configured registry.

The fragment (`#entry`) selects an export key on the resolved package. Without
a fragment, the package's `.` export is used.

A filesystem lock at `<root>/.lock` (atomic `fs.open(path, 'wx')`, with PID +
start time inside) serializes the install across kernel processes that share
a manifest. Processes whose `package.json` hash matches `.telo-state.json` and
whose `node_modules/` already exists short-circuit the install entirely.

---

## 5. Package Export Resolution

Once the package root is located, the loader resolves the entry file:

1. Read `package.json` (or the language-equivalent manifest).
2. Look up the entry key (e.g. `"./http-server-api"`) in the export map.
3. If the export map contains condition keys, prefer them in this order:
   - Runtime-specific key (e.g. `bun` before `import` in a Bun runtime)
   - `import`, `default`, `require` (in that order for JS/TS runtimes)
4. If no export map is present, fall back to the `module` or `main` field (JS only).
5. If the resolved path does not exist verbatim, attempt common extensions (`.js`, `.ts`).

---

## 6. Controller Module Interface

A controller module must export at least one of `create` or `register`.

```
register(ctx)   — called once before any resource is initialized; optional
create(resource, ctx) → instance | null   — called once per resource; required
```

The loader validates the loaded module against this contract and throws if neither
`create` nor `register` is exported.

---

## 7. Cross-process install safety

Two Telo processes against the same manifest (CLI + IDE, watch + run, parallel
CI shards) would otherwise race on `npm install` and corrupt the tree. The
loader holds an OS-level lock (`fs.open(.lock, 'wx')`) around any
manifest-tree mutation. Stale-holder detection: the file body records the
holding process's PID and start time; lockfiles older than 60 seconds whose
PID isn't alive are reclaimed. After acquiring, the late arriver re-checks
state — if the install root's `package.json` hash matches the desired one and
`node_modules/<pkg>` already exists, the lock-holder skips the install entirely.

The legacy global cache at `~/.cache/telo/npm/` is no longer used. Earlier
installs of Telo may have left it behind; it can be removed by hand and the
loader will not consult it.

---

## 8. Error Codes

| Code                       | Condition                                                   |
| -------------------------- | ----------------------------------------------------------- |
| `ERR_CONTROLLER_NOT_FOUND` | No PURL candidates matched the current runtime, or the PURL |
|                            | list was empty                                              |
| `ERR_CONTROLLER_INVALID`   | Module loaded successfully but exports neither `create` nor |
|                            | `register`                                                  |
