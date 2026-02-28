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
telo ./examples/hello-api/module.yaml

# Run from a remote URL
telo https://raw.githubusercontent.com/diglyai/telo/main/examples/hello-api/module.yaml

# Watch mode - auto-restart on file changes
telo --watch ./manifest.yaml
```

## Commands

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
imports:
  - https://raw.githubusercontent.com/diglyai/telo/refs/heads/main/modules/http-server/module.yaml
  - https://raw.githubusercontent.com/diglyai/telo/refs/heads/main/modules/javascript/module.yaml
---
kind: Http.Server
metadata:
  name: MyServer
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
