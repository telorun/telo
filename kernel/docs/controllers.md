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

---

## 2. Qualifiers

### `local_path`

A relative path from the **definition file** (`Telo.Definition` YAML) to the local
package directory.

```
pkg:npm/@telorun/http-server@>=0.1.0?local_path=./nodejs#http-server
```

`local_path` is only honoured when the definition file was loaded from a **local file path**
(not an HTTP/HTTPS URL). When it is honoured and the path exists, resolution stops — no
registry or cache is consulted.

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

## 4. Resolution Order

The loader resolves a PURL through the following steps in order, stopping at the first
successful result:

```
1. local_path  (only when definition is loaded from a local file)
   └── resolve local_path relative to the definition file's directory
   └── if the path exists → use it

2. Host-local package directory (node_modules, GOPATH, etc.)
   └── check if the package is already installed/linked in the host environment
   └── if found → use it

3. Registry cache  (~/.cache/telo/<type>/<hash>/)
   └── if not already cached → download from registry
   └── use cached copy
```

**Step 1** supports monorepo development: definition files with `local_path` load directly
from the workspace without touching the network or cache.

**Step 2** supports project-level overrides: packages installed in the host project (e.g.
via a workspace symlink) take precedence over the global cache.

**Step 3** is the production path: the package is fetched from the registry and stored in
a content-addressed local cache keyed on the PURL. Subsequent runs skip the download.

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

Full interface is defined in [README.md § 5](README.md#5-controller-interface).

The loader validates the loaded module against this contract and throws if neither
`create` nor `register` is exported.

---

## 7. Cache Layout

The global cache lives under `~/.cache/telo/<type>/`. Each package is stored in a
subdirectory keyed by a short hash of the primary PURL:

```
~/.cache/telo/
  npm/
    4128729367d3/          # hash of "pkg:npm/@telorun/http-server@>=0.1.0"
      package.json         # bootstrap manifest for the install
      node_modules/
        @telorun/
          http-server/
```

The cache directory for a package is created lazily on first use. If `package.json` is
already present inside the expected location, the download is skipped entirely.

---

## 8. Error Codes

| Code                       | Condition                                                   |
| -------------------------- | ----------------------------------------------------------- |
| `ERR_CONTROLLER_NOT_FOUND` | No PURL candidates matched the current runtime, or the PURL |
|                            | list was empty                                              |
| `ERR_CONTROLLER_INVALID`   | Module loaded successfully but exports neither `create` nor |
|                            | `register`                                                  |
