# Telo CLI

The Telo CLI is the command-line interface for the Telo kernel. It loads and runs YAML manifests on your local machine, watches them for changes during development, statically validates them with `telo check`, pre-installs controllers with `telo install`, refreshes `imports:` pins with `telo upgrade`, and publishes module manifests to the Telo registry with `telo publish`.

## Installation

```bash
npm install -g @telorun/cli
# or
pnpm add -g @telorun/cli
```

## Quick Start

```bash
# Run a local manifest
telo ./examples/hello-api.yaml

# Run from a remote URL
telo https://raw.githubusercontent.com/telorun/telo/main/examples/hello-api.yaml

# Watch mode - auto-restart on file changes
telo --watch ./manifest.yaml
```

## Commands

### `telo publish <paths..>`

Publish one or more module manifests to the Telo registry. For each manifest, the command:

1. Finds all `controllers` entries with a `local_path` qualifier (i.e. locally-developed packages).
2. Optionally bumps each controller package version with `--bump`.
3. Builds each controller package.
4. Publishes each controller package to its registry (currently npm). If the version already exists, the publish step is skipped — the command is idempotent.
5. Rewrites the PURL version specs in the manifest to exact static versions.
6. Bumps `metadata.version` in the manifest when `--bump` is given.
7. Pushes the updated manifest to the Telo registry.

```bash
telo publish ./modules/my-module/telo.yaml
telo publish ./modules/my-module/telo.yaml --bump=patch
telo publish ./modules/a/telo.yaml ./modules/b/telo.yaml --bump=minor
telo publish ./modules/my-module/telo.yaml --dry-run
telo publish ./modules/my-module/telo.yaml --skip-controllers
```

**Options:**

- `--bump patch|minor|major` — Bump all controller package versions before publishing. Also bumps `metadata.version` in the manifest.
- `--registry <url>` — Telo registry base URL (default: `https://registry.telo.run`)
- `--dry-run` — Show what would happen without writing files or publishing anything.
- `--skip-controllers` — Skip the controller build/publish/PURL-rewrite loop and only run static analysis and push the manifest to the Telo registry. Use this when controller packages have already been published by another tool (e.g. Changesets in CI). Mutually exclusive with `--bump`.

**Environment:**

- `TELO_REGISTRY_TOKEN` — Bearer token for the registry's publish endpoint. The CLI adds it as `Authorization: Bearer <token>` on each PUT; without it, the server returns 401. Operators receive a token from whoever administers the registry. Example:

  ```bash
  TELO_REGISTRY_TOKEN=<token> telo publish ./modules/my-module/telo.yaml
  ```

---

### `telo check <paths..>`

Statically validates one or more manifests without running them. Uses the Telo analyzer to check schema correctness, `x-telo-ref` references, CEL expression types, and resource scope visibility. Exits with code 1 if any errors are found.

```bash
telo check ./manifest.yaml
telo check ./modules/my-module/telo.yaml
telo check https://example.com/manifest.yaml
```

Accepts local paths, directories containing a `telo.yaml`, or HTTP(S) URLs.

**Example output:**

```
manifest.yaml:14:5  error    Unknown resource kind "Http.Srver"  E001
manifest.yaml:22:7  warning  Unused variable "port"  W003

2 errors, 1 warning
```

On success:

```
✓  No issues found
```

---

### `telo install <paths..>`

Pre-downloads every controller declared by a manifest and its transitive imports into the on-disk cache, and persists every imported manifest's YAML alongside it. At runtime the kernel finds each controller already installed AND resolves every import from disk — boot does zero network I/O.

Installs run in parallel; failures are reported per controller and the command exits non-zero if any failed. Subsequent runs are idempotent — already-cached packages are skipped, and manifest cache files are overwritten with freshly fetched bytes.

```bash
telo install ./apps/my-app/telo.yaml
telo install ./apps/a/telo.yaml ./apps/b/telo.yaml
```

**Options:**

- `--registry-url <url>` — Base URL for the telo module registry. Overrides `TELO_REGISTRY_URL`. Affects both the network fetches and the on-disk cache layout (manifests served by this registry are stored under `<namespace>/<name>/<version>/...`).

**Environment:**

- `TELO_REGISTRY_URL` — Default registry URL used when `--registry-url` is omitted.
- `TELO_PKG_MANAGER` — Override the package manager invoked for controller installs. Defaults to `npm`. Set to `pnpm` (or any compatible CLI) when the runtime environment ships a different manager.

The cache lives next to the manifest at `<entry-manifest-dir>/.telo/`:

- `.telo/npm/` — controller node_modules tree (one realm per manifest).
- `.telo/manifests/<namespace>/<name>/<version>/telo.yaml` — registry-served manifests.
- `.telo/manifests/__http/<host>/<pathname>` — manifests imported via raw HTTP URLs.

Per-manifest scope means the whole `.telo/` tree is naturally portable: `COPY` the manifest dir into your image and both caches travel with it; no environment variable is required.

**Example output:**

```
Installing 20 controllers for apps/my-app/telo.yaml
  ✓  pkg:npm/@telorun/http-server@0.10.0?local_path=./nodejs#http-server
  ✓  pkg:npm/@telorun/http-client@0.6.0?local_path=./nodejs#http-client
  ...

✓  20 installed in 3.2s
```

**Typical Dockerfile usage:**

```dockerfile
FROM telorun/node:latest-slim as build
WORKDIR /srv
COPY apps/my-app/ apps/my-app/
COPY modules/ modules/
RUN telo install apps/my-app/telo.yaml

FROM telorun/node:latest-slim as production
WORKDIR /srv
COPY --from=build /srv /srv
CMD ["apps/my-app/telo.yaml"]
```

Available image variants:

- `telorun/node:<version>` — debian base, no rust toolchain.
- `telorun/node:<version>-slim` — debian-slim base, no rust toolchain (smallest footprint; recommended for production).
- `telorun/node:<version>-rust-<rust-version>` — debian + rust toolchain (controllers that compile native deps at install time).
- `telorun/node:<version>-rust-<rust-version>-slim` — slim + rust toolchain.

Pin to an exact CLI version for reproducible builds; `latest`, `<major>`, and `<major>.<minor>` are rolling tags.

The build stage materializes `<manifest-dir>/.telo/npm/` and `<manifest-dir>/.telo/manifests/`; the production stage is a single `COPY` and does no network I/O at boot.

---

### `telo upgrade <paths..>`

Scans one or more manifests for `imports:` entries whose source is a registry ref (`<namespace>/<name>@<version>`), queries the registry for the latest published version of each, and rewrites the source in place when a newer version is available. Both the scalar shorthand (`Alias: <src>`) and the object form (`Alias: { source: <src>, … }`) are handled. The rewrite operates at the byte level: only the version characters of changed source values are spliced into the original file. Comments, indentation, folded block scalars (`>-` / `|`), quote style on the source value, and every other byte outside the rewritten ranges are preserved exactly. The on-disk YAML is mutated only when at least one import in the file changes.

Accepts the same path shapes as `check` / `install`: a manifest file, a directory containing a `telo.yaml`, or several of those mixed. The command never follows imports recursively — only the imports declared in the files you pass on the command line are inspected.

```bash
telo upgrade ./apps/my-app/telo.yaml
telo upgrade ./apps/my-app                       # directory → ./apps/my-app/telo.yaml
telo upgrade ./apps/a ./apps/b --dry-run
telo upgrade ./manifest.yaml --include-prerelease
```

**Options:**

- `--registry-url <url>` — Base URL for the Telo registry. Falls back to `TELO_REGISTRY_URL`, then `https://registry.telo.run`. Matches the `install` / `run` fallback chain.
- `--include-prerelease` — Consider versions with a SemVer prerelease segment (e.g. `1.0.0-beta.1`) when picking the latest. Off by default — prereleases are ignored unless the flag is set.
- `--dry-run` — Show the proposed rewrites without touching any files.

**Behavior per import:**

| Pinned version state | Action | Log marker |
| --- | --- | --- |
| Equal to the latest published | leave unchanged | `=  already at <ver>` |
| Lower than the latest, and itself in the registry | rewrite to latest | `↑  <old> → <new>` |
| Not present in the registry's version list | rewrite to latest (repair) — flagged with `(pinned version not in registry)`. Direction can be downward if the broken pin is higher than anything published. | `↑` or `↓` |
| Module not found (404) / no eligible versions after filtering | leave unchanged, report | `!  no published versions in registry` |
| `source` is not a `<namespace>/<name>@<version>` ref (relative path, HTTP URL, alias) | leave unchanged | `·  skipped (not a registry ref)` |

A non-existent pin is always treated as broken and repaired against the registry — leaving an unbootable pin in place would defeat the point of the command — but the rewrite is annotated so the action is visible. Network or non-404 registry errors are surfaced per import and produce a non-zero exit code; other imports in the same file still get processed.

**Environment:**

- `TELO_REGISTRY_URL` — Default registry URL used when `--registry-url` is omitted.

**Example output:**

```text
Upgrading apps/my-app/telo.yaml
  ↑  std/run  0.2.4 → 0.2.7
  =  std/http-server  already at 2.0.0
  ↓  std/foo  9.9.9 → 0.4.1  (pinned version not in registry)
  !  std/does-not-exist  no published versions in registry
  ·  ../sibling  skipped (not a registry ref)

2 upgraded, 1 already current, 2 skipped
```

---

### `telo [manifest]`

Load and run a Telo manifest.

**Arguments:**

- `manifest` - Path to a YAML manifest file or directory. Can be local or a remote URL.

**Options:**

- `--watch, -w` - Watch manifest file(s) for changes and restart automatically
- `--verbose, -v` - Enable verbose logging
- `--help, -h` - Show help message
- `--version` - Show version number

## Examples

### Simple HTTP Server

Create a file `server.yaml`:

```yaml
kind: Telo.Application
metadata:
  name: Example
imports:
  HttpServer: std/http-server@0.11.0
  JavaScript: std/javascript@0.5.0
targets:
  - Server
---
kind: Http.Server
metadata:
  name: Server
  module: Example
baseUrl: http://localhost:8080
port: 8080
mounts:
  - path: /api
    type: Http.Api.HelloApi
---
kind: Http.Api
metadata:
  name: HelloApi
  module: Example
routes:
  - request:
      path: /hello
      method: GET
    handler:
      kind: JavaScript.Script
      code: |
        function main() {
          return { message: 'Hello World!' }
        }
    response:
      status: 200
      statuses:
        200:
          body:
            message: "${{ result.message }}"
```

Run it:

```bash
telo server.yaml
```

Access it at `http://localhost:8080/api/hello`

### Watch Mode for Development

```bash
telo --watch ./manifest.yaml
```

In watch mode, the manifest is reloaded and the kernel restarted whenever any manifest files change. This is useful while developing.

### Remote Manifests

You can run manifests directly from URLs without downloading them:

```bash
telo https://example.com/my-manifest.yaml
```
