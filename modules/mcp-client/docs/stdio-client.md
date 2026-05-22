---
description: "Mcp.StdioClient — child-process stdio transport for MCP. Spawns the server at boot, handshakes before init() returns, terminates cleanly on teardown."
sidebar_label: Mcp.StdioClient
---

# `Mcp.StdioClient`

> Examples below assume `mcp-client` is imported as `McpClient`.

A long-lived MCP client backed by the stdio transport. Spawns and owns a
child process; speaks newline-delimited JSON-RPC over the child's stdin /
stdout per the MCP stdio transport spec.

The stdio connection itself is the session — no `Mcp-Session-Id`, no
re-handshake, no `sessionProvider:` slot. The process lifecycle replaces the
HTTP session lifecycle entirely.

## Schema

```yaml
kind: McpClient.StdioClient
metadata: { name: <Name> }
command: /usr/local/bin/some-mcp-server
args: ["--stdio", "--cwd", "/srv"]
env:                                # optional; merged into child's process.env
  MCP_LOG_LEVEL: debug
clientInfo:
  name: my-client
  version: 1.0.0
shutdownGraceMs: 5000               # optional, default 5000
```

The MCP protocol version is negotiated by the SDK during the initialize
handshake; there is no manifest-level override.

## Lifecycle

- **`init()`** spawns the child via `child_process.spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] })`, then runs the MCP `initialize` + `notifications/initialized` handshake. A child that exits during this window — or sends a malformed initialize response — makes `init()` throw and the kernel surfaces the boot failure with the captured stderr.
- **`invoke({ method, params })`** writes a framed JSON-RPC request and awaits the matching response on stdout. Concurrent calls are correlated by ID, not call ordering. `ERR_MCP_SESSION_INVALID` is unreachable here — a dead session surfaces as `ERR_MCP_TRANSPORT` via child-process exit.
- **`teardown()`** asks the SDK to close the transport (which SIGTERMs the child) and waits up to `shutdownGraceMs` ms for a clean exit. If the child is still alive after the grace window, the controller escalates with an explicit `SIGKILL` via `process.kill(pid, "SIGKILL")` and emits a `<Name>.ChildForceKilled` runtime event. Any in-flight `invoke()` calls reject with `ERR_MCP_TRANSPORT`.

## Stderr

Child stderr is forwarded to the kernel log per-line at `debug` level (each
line emitted as a `<Name>.Stderr` runtime event). Stderr is not part of any
user-facing surface — manifest authors who need to inspect server logs run
the server out-of-band.

## `snapshot()` surface

`{ command, argv, pid }`. `env` is **not** exposed — the user-supplied map
can carry secrets.

## Errors

Same code set as `Mcp.HttpClient` minus `ERR_MCP_SESSION_INVALID`. See the
[README error contract](../README.md#error-contract).
