# Telo CLI

The Telo CLI is the command-line interface for the Telo kernel. It loads YAML manifests and runs them on your local machine.

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
telo publish ./modules/my-module/module.yaml
telo publish ./modules/my-module/module.yaml --bump=patch
telo publish ./modules/a/module.yaml ./modules/b/module.yaml --bump=minor
telo publish ./modules/my-module/module.yaml --dry-run
```

**Options:**

- `--bump patch|minor|major` — Bump all controller package versions before publishing. Also bumps `metadata.version` in the manifest.
- `--registry <url>` — Telo registry base URL (default: `https://registry.telo.run`)
- `--dry-run` — Show what would happen without writing files or publishing anything.

**Example output:**

```
Publishing modules/run/module.yaml

  @telorun/run
    bump     0.1.1 → 0.1.2
    build    ✓
    publish  ✓  @telorun/run@0.1.2
    purl     @0.1.1 → @0.1.2

  manifest
    version  0.1.0 → 0.1.1
    push     ✓  std/run@0.1.1 → https://registry.telo.run/std/run/0.1.1
```

---

### `telo check <paths..>`

Statically validates one or more manifests without running them. Uses the Telo analyzer to check schema correctness, `x-telo-ref` references, CEL expression types, and resource scope visibility. Exits with code 1 if any errors are found.

```bash
telo check ./manifest.yaml
telo check ./modules/my-module/module.yaml
telo check https://example.com/manifest.yaml
```

Accepts local paths, directories containing a `module.yaml`, or HTTP(S) URLs.

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
kind: Kernel.Module
metadata:
  name: Example
targets:
  - Server
---
kind: Kernel.Import
metadata:
  name: HttpServer
source: std/http-server@1.0.1
---
kind: Kernel.Import
metadata:
  name: JavaScript
source: std/javascript@1.0.0
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

## Status

The CLI is part of the Telo project and follows the same early prototype status. The command-line interface and behavior may change.

## See Also

- [Telo Kernel](../kernel/README.md) - Core concepts and resource types
- [Modules](../modules/README.md) - Available built-in modules
