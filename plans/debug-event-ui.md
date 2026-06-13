# Debug Event UI

A live, filterable browser view of the kernel event stream, replacing the
"`--debug` writes a JSONL file you grep by hand" experience. Spans three homes
because the kernel is **polyglot** (Node today, Rust/Go later) while the editor
and UI are not.

## The polyglot boundary

The kernel runtime is the **producer**: it taps events, collapses live in-process
values to a portable shape, and serves them. That logic is reimplemented per
runtime — the TypeScript version is just the Node implementation, never a package
the editor or a Rust kernel imports.

What is shared across runtimes is the **wire format**: the JSON event shape plus
the value-encoding rules. That is a language-neutral *spec*, conformed to by each
producer. Everything downstream (the UI, the editor) codes against the spec, not
against any runtime.

```
WIRE-FORMAT SPEC  (JSON Schema + docs — the cross-runtime contract)
      │ conformed to by ↓
PRODUCER (per runtime: serialize + SSE server + serve the UI bundle)
   Node now → DebugEventSubscriber + DebugServer in the CLI
   Rust/Go later → reimplemented; serves the same bundle as static bytes
      │ emits wire format over SSE ↓
CONSUMERS (TS/JS, never rewritten)
   ├─ standalone UI bundle  ← served as static bytes by ANY producer
   └─ telo-editor panel     ← imports the same components; connects to the SSE URL
```

## Pieces

### 1. Wire-format spec — the contract

- A JSON Schema for the event envelope: `{ timestamp, event, payload, metadata? }`.
- The value-encoding rules (already implemented Node-side in
  [debug-event-subscriber.ts](../cli/nodejs/src/debug-event-subscriber.ts), now
  promoted to a documented contract):
  - resolved `!ref` → `{ kind, name }`
  - live / unrepresentable value (controller instance, stream, client, fn, bigint)
    → `"[Marker]"` string
  - reference cycle → `"[Circular]"`
  - everything else → plain JSON
- The SSE endpoint contract: `GET /events` (replay buffer + live tail),
  `GET /events.jsonl` (full history download), `GET /` (the UI bundle).
- Lives as: a JSON Schema file + a `docs/` page. The TS projection of these types
  ships in `@telorun/debug-ui` (below); the schema is the source of truth so a
  Rust/Go producer can conform.

### 2. Node producer — `DebugServer` (in the CLI)

- `DebugEventSubscriber` (the serializer) already exists and stays — it *is* the
  Node implementation of the wire format.
- New `DebugServer` (Node built-in `http`, no deps):
  - Binds **`127.0.0.1` only** (events can carry secrets — localhost is non-negotiable).
  - In-memory **ring buffer** (last N events, e.g. 5–10k) for replay-on-connect.
  - `GET /events` — SSE; on connect, flush the buffer then stream live. Each event
    is `data: <serialized>\n\n`.
  - `GET /events.jsonl` — the file, for download.
  - `GET /` and assets — serve the `@telorun/debug-ui` standalone bundle (embedded
    as bytes / read from its `dist/`).
- Picks a default port with free-port fallback; prints `Debug UI: http://localhost:<port>`.

### 3. `@telorun/debug-ui` — shared consumer package (`packages/debug-ui`)

Browser-safe, runtime-agnostic, React (sits beside `@telorun/ide-support`).
Depends on **no Node-only package** — in particular not `@telorun/runner-core`
(`fastify`-based, Node-only). No `fs`/`http`/`path` imports; runs in the editor's
webview and any browser.

- **Wire types** — TS projection of the spec.
- **Filter/query logic** — pure predicates (by event suffix `*.Invoked` / `*.Failed`,
  by kind/name, free-text search). Shared by both UI hosts so filtering is identical.
- **SSE client** — connect, parse, reconnect, feed a bounded client-side buffer.
- **React components** — `EventTable`, `FilterBar`, `PayloadInspector` (pretty-JSON,
  expandable), with color-coding by event suffix; pause/resume, clear, autoscroll.
- **Two entry points from one component set:**
  - a **standalone `App`** built (Vite) to a static `dist/` bundle that producers serve;
  - the **components** exported as source for the editor to compose into its panel.

### 4. Editor integration (`apps/telo-editor`)

- Editor depends on `@telorun/debug-ui` (components only — never the producer).
- A **Debug panel** in the run session, alongside the terminal. It connects to the
  running app's debug SSE URL; the run adapter already knows the app host/port and
  [Docker port forwarding](../apps/telo-editor/plans/docker-port-forwarding.md)
  already exists for reaching mapped ports.
- Surfaced through the editor's **own** browser-safe run-session model
  ([run/types.ts](../apps/telo-editor/src/run/types.ts) `RunEvent`, defined locally
  in the editor): debug events appear in the run-session UI either as a new editor
  `RunEvent` variant or a sibling SSE stream owned by the panel (decided in Phase 4).
  The editor does **not** depend on `@telorun/runner-core` (Node-only) and must not
  start to.

## Flag behavior

`--debug` does **both**: appends `<manifest-dir>/.telo.debug.jsonl` *and* starts
`DebugServer`, printing the UI URL. It also **auto-opens** the UI in the default
browser (like `nx graph`) — once per process (so a `--watch` session doesn't spawn
a tab per reload), skipped on CI / headless boxes (no `DISPLAY`), and opt-out via
`--no-debug-open`. (Single flag for now; can split later if the always-on server
becomes unwanted.)

## Phasing

1. **Wire spec + types** — JSON Schema, `docs/` page, TS types in `@telorun/debug-ui`.
2. **`@telorun/debug-ui` MVP** — SSE client, filter logic, components, standalone bundle.
3. **CLI `DebugServer`** — SSE + ring buffer + serve bundle; wire into `--debug`.
4. **Editor panel** — `@telorun/debug-ui` components in a run-session Debug panel.
5. **Later** — Rust/Go producer conformance against the spec (out of scope for the
   first cut; the spec is what makes it tractable).

## Testing

- CLI: start `DebugServer`, open an SSE client, assert live events + buffer replay
  + localhost-only binding.
- `@telorun/debug-ui`: unit-test filter predicates; component smoke tests.
- Manual: `PORT=… pnpm run telo --debug ./examples/configurable-http-server.yaml`,
  open the printed URL, watch the stream, filter, expand a payload.

## Release / docs

- New `@telorun/debug-ui` package → changeset; CLI + editor changesets for the new
  dependency. Spec/docs page wired into `pages/` (sidebars + docusaurus include).

## To decide during implementation

- Default debug UI port + free-port fallback strategy.
- Editor: debug events as a new editor-local `RunEvent` variant vs. a panel-owned
  SSE connection (Phase 4).
- Standalone bundle embedded as bytes in the CLI vs. served from the package's
  installed `dist/` path.
