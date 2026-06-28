# @telorun/mcp-client

## 0.4.1

### Patch Changes

- 4e5d861: Guard `process.env` against controllers bypassing declared bindings. Once the
  kernel boots it replaces the global `process.env` with a guardrail Proxy whose
  denied set is **derived from the manifest**: exactly the host env-var names the
  root Application binds via `variables` / `secrets` / `ports` (their `env:` keys).
  Such a key reads back `undefined` (and `'FOO' in process.env` / enumeration see
  nothing) even when the variable is set, and the first read of each logs a
  warning. Controllers must read those through `ctx.env` (the sanctioned snapshot
  the kernel threads in) or, preferably, the declared `variables` / `secrets`.

  Every **other** key passes through transparently (real value, no warning) — the
  kernel carries no allowlist of vendor env conventions. A bundled SDK reading its
  own configuration (`NODE_ENV`, `AWS_PROFILE` / `AWS_*` / `SMITHY_*`, `~/.aws`
  path lookups, `BUN_*`, the AWS Lambda execution-environment context, …) is
  undeclared, so it is untouched. The guarantee is narrow and honest: a controller
  cannot bypass a _declared_ binding by reading its raw env var. This is a
  guardrail, not an isolation boundary — in-process controllers can still reach the
  OS environment by other means; the `process.env` property is left non-writable so
  a casual `process.env = {…}` cannot drop it.

  The denied set is process-global and additive: several `Kernel` instances can
  boot in one process (the test suite runs child kernels in-process), and each
  unions its declared keys into the shared set even after the Proxy is installed.

  The kernel's own `TELO_*` / cache reads and its subprocess spawns (`npm`,
  `cargo`/`rustc`) use the real environment captured before the lock — shared on
  `globalThis` so a second in-process `@telorun/kernel` copy (the test suite loads
  its own to spawn child kernels) recovers it even when loaded after the lock,
  rather than capturing the Proxy and handing child spawns an env missing the
  denied keys. `analyzeOnly` loads never boot, so `telo check` / the editor / the
  analyzer are unaffected.

  The stdlib controllers that read host env use `ctx.env`: `config`
  (`Config.EnvironmentVariableStore`), `lambda` (Lambda mode detection),
  `mcp-client` (the spawned stdio child's environment), and `test` (the env the
  suite forwards to each spawned test kernel). These keep their existing behaviour
  and remain compatible with older kernels.

## 0.4.0

### Minor Changes

- ee8926f: Unify resource references on the `!ref` YAML tag. The object form `{ kind, name }`
  and bare-string references are removed: the analyzer rejects them up front
  (`INVALID_REFERENCE_FORM`) and `!ref <name>` / `!ref <Alias>.<name>` is the only
  authored shape. `resolveRefSentinels` now resolves `!ref` sentinels across the
  whole manifest tree (including step `invoke`s and refs nested in inline
  definitions), so every consumer sees the uniform resolved shape. The
  http-server mount slot is renamed `mounts[].type` → `mounts[].mount`, and the
  mcp transports / clients read their Phase-5-injected ref instances directly.

  Schema validation (analyzer and kernel) now drops the stale scalar `type` a ref
  slot may still pin (older published modules encode references as `type: string`)
  before running AJV, so a resolved reference object validates against a legacy
  `x-telo-ref` slot. This keeps an app that consumes a not-yet-republished
  dependency analyzable and bootable during the migration. Object-typed ref slots
  that also accept an inline value (e.g. `inputType` / `outputType`) are left
  untouched.

  `Run.Sequence` reference slots are brought onto the same enforcement path: a
  step `invoke` and a scope `targets` entry now require a `!ref` (the `targets`
  slot gains an `x-telo-ref` constraint and the `with` scope's visibility extends
  to `/targets`), so a bare-string ref at either is rejected with
  `INVALID_REFERENCE_FORM` at `telo check` — uniform with `Telo.Application`
  targets — instead of failing as an obscure runtime error. The controller reads
  the resolved reference rather than a bare name.

## 0.3.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.3.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.2.1

### Patch Changes

- 4c1a50b: Refresh in-tree documentation version pins to the current registry latest.

## 0.2.0

### Minor Changes

- 8eff8a9: Introduce `@telorun/mcp-client` (v0.1.0) — first-class Model Context Protocol
  client resource kinds. Replaces the hand-rolled `JS.Script` MCP fetchers in
  `modules/mcp-server/tests/http-tool-call.yaml` and
  `apps/registry/tests/e2e/mcp-tools.yaml` with typed kinds:

  - **`Mcp.Client`** (`Telo.Abstract` over `Telo.Invocable`) — generic
    JSON-RPC request contract every transport satisfies.
  - **`Mcp.HttpClient`** — Streamable HTTP transport. Owns lazy `initialize`
    handshake on first call, cached `Mcp-Session-Id`, transparent
    re-handshake on session-invalid responses, best-effort `DELETE` on
    teardown. Switches to external-source mode when a `sessionProvider:` is
    declared.
  - **`Mcp.StdioClient`** — child-process stdio transport. Spawns the server
    at boot, handshakes before `init()` returns, terminates cleanly on
    teardown.
  - **`Mcp.SessionProvider`** (`Telo.Abstract` over `Telo.Provider`) — pluggable
    source for externally-managed MCP session IDs. No bundled concretes;
    consumers author template-form providers via `extends:
McpClient.SessionProvider`.
  - **`Mcp.ToolsCall`** / **`Mcp.ToolsList`** (`Telo.Invocable`) — dispatch
    `tools/call` and `tools/list` through any `Mcp.Client` with zero transport
    knowledge. `Mcp.ToolsCall`'s `outputType` is closed (`content[]` is a
    typed `oneOf` union) so `${{ steps.X.result.content[0].text }}` is
    statically validated end-to-end; soft tool failures (`isError: true`) are
    converted to `ERR_MCP_TOOL_ERROR` throws so the success path never
    observes them.
  - Closed `ERR_MCP_*` error union: `ERR_MCP_TRANSPORT`, `ERR_MCP_PROTOCOL`,
    `ERR_MCP_JSON_RPC_ERROR`, `ERR_MCP_TOOL_ERROR`, `ERR_MCP_SESSION_INVALID`.

  `Mcp.HttpClient` is implemented hand-rolled on top of `fetch` (one POST per
  RPC) rather than via `@modelcontextprotocol/sdk`'s
  `StreamableHTTPClientTransport`. The SDK transport opens a server-pushed
  SSE GET stream on `notifications/initialized` that deadlocks against a
  co-located `Http.Server`'s `app.close()` during teardown — Fastify waits
  for in-flight responses to drain, the SSE GET only closes when
  `Mcp.HttpClient.teardown()` runs, but teardown can't run until the
  parent `with:` scope finishes. The hand-rolled path is also what
  external-provider mode needed anyway, so both modes share one code path
  (`postJsonRpc`) and the SDK/hand-rolled drift concern collapses to a single
  implementation.

  `postJsonRpc` has fetch-stubbed vitest unit-test coverage for every branch
  of the closed `ERR_MCP_*` union: SSE plus application/json envelope
  parsing, 404/410 / JSON-RPC -32001/-32002 → `ERR_MCP_SESSION_INVALID`,
  other 4xx/5xx / unexpected Content-Type / network failure →
  `ERR_MCP_TRANSPORT`, malformed JSON / empty SSE / envelopes missing both
  `result` and `error` → `ERR_MCP_PROTOCOL`, generic JSON-RPC error
  envelopes → `ERR_MCP_JSON_RPC_ERROR`, request `Mcp-Session-Id` header
  forwarding, response session-id capture, and the notification (no-id)
  fire-and-forget path.

  Remaining coverage gap: the end-to-end external `sessionProvider:` flow
  (through the `Mcp.SessionProvider` abstract resolving a template-form
  provider concrete) has no integration test today. A follow-up should add a
  YAML test using a user-authored `Mcp.SessionProvider` concrete plus a
  control HTTP fixture that returns 404 on the second call to verify the
  transparent re-handshake under self-handshake mode too.

  Tightens `Http.Request.outputType` (additive) to declare the canonical Telo
  Response Object — `{ status: integer, headers: Record<string, string>, body:
unknown }` — that the runtime controller already returns. Pure schema-only
  change with no behavioural delta in `@telorun/http-client`; the chain
  validator now catches typos in `status` / `headers` / the top-level `body`
  property of `${{ result.* }}` access against `Http.Request` steps. The
  session-provider Vault example in `modules/mcp-client/docs/session-providers.md`
  relies on this tightening for end-to-end chain validation of
  `${{ result.body.data.session_id }}`.
