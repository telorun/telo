# @telorun/debug-ui

Browser-safe building blocks for watching a running Telo app's debug stream:
**filter logic**, an **SSE client**, and **React components** (a **Logs / Events**
tab split) — plus a standalone single-page app, built both multi-file
(`app-dist/`) and as one self-contained file (`app-single/index.html`).

The **wire format** itself lives in [`@telorun/debug-wire`](../debug-wire); this
package re-exports its types. A stream carries two frame kinds: `kind: "event"`
(kernel events) and `kind: "log"` (stdout/stderr lines).

This package is a **consumer**: it parses events, it never produces them. It has
no Node-only dependency (no `fs`/`http`, not `@telorun/runner-core`) so it runs
in any browser and in the editor webview.

## Why it's shaped this way

The Telo kernel is polyglot — Node today, Rust/Go later. The thing that *produces*
debug events (taps the kernel, serializes values, serves them) lives inside each
runtime and is reimplemented per language. What's shared across runtimes is the
**wire format**, not code. Every consumer (this package, the editor) codes against
that contract; the Node producer lives in the CLI.

```
wire format (@telorun/debug-wire)              ← the cross-runtime contract
  produced by → a kernel runtime's debug server (Node: the telo CLI)
  consumed by → the standalone app (served by the producer) + the editor panel
```

## Wire format

Each frame is one JSON object, delivered one-per-line over SSE and JSONL. Schema
and types: [`@telorun/debug-wire`](../debug-wire). An **event** frame:

```json
{ "kind": "event", "timestamp": "2026-06-13T07:00:00.000Z", "event": "Server.Listening",
  "payload": { "port": 5599, "mounts": [{ "path": "/v1", "mount": { "kind": "Http.Api", "name": "Api" } }] } }
```

A **log** frame (one stdout/stderr line):

```json
{ "kind": "log", "timestamp": "2026-06-13T07:00:00.000Z", "stream": "stdout", "line": "listening on :5599" }
```

Producers reduce event `payload` values to wire-safe forms before sending:

| Value | Encodes as |
|---|---|
| byte buffer (`Uint8Array`/`Buffer`, any file kind) | `{ "$blob": "blobs/<id>", "mediaType", "byteLength" }` — a pointer; bytes are offloaded to the producer's blob store, fetched on demand. The key it sits under is preserved. |
| resolved `!ref` (live resource instance) | `{ "kind", "name" }` |
| other live / unrepresentable value (controller, stream, client, function, bigint) | `"[Marker]"` (e.g. `"[Stream]"`, `"[Kernel]"`) |
| reference cycle | `"[Circular]"` |
| anything else | plain JSON |

A non-TS producer (Rust/Go) conforms to the same table.

### Blobs (binary payloads)

The bytes never enter the log. A producer offloads each buffer to a
content-addressed store (so identical buffers dedupe) and emits a `$blob`
pointer — a path **relative to the producer origin**. The consumer resolves it
against the debug-server URL and fetches `GET /blobs/<id>` (which sets the real
`Content-Type`). `mediaType` is sniffed from magic bytes, falling back to
`application/octet-stream`. The UI renders `image/*` inline and other types as a
download link; `byteLength` + sibling `width`/`height` (if present) form the
caption. An evicted blob 404s — the log keeps the pointer + metadata, so you
still see *what* it was.

## Endpoints (served by a producer's debug server)

- `GET /` — the standalone UI (the self-contained `app-single/index.html` bytes).
- `GET /events` — SSE; on connect, the producer flushes its replay buffer, then
  streams live events.
- `GET /events.jsonl` — the full event log, for download.
- `GET /blobs/:id` — a binary payload offloaded from an event (see Blobs below).
- `GET /json/version` — discovery handshake: `{ protocol, protocolVersion, url,
  events, eventsLog, blobs, appEndpoints }`, so a consumer can confirm the wire
  format before connecting. `appEndpoints` is the running app's exposed addresses
  (`{ host, port, protocol, url? }[]`); a blank `host` means the producer couldn't
  know which hostname the viewer used — the UI fills it from the page origin.

The Telo CLI exposes this server with `telo run <manifest> --inspect[=[host:]port]`
(loopback `127.0.0.1:9230` by default). It serves the UI **same-origin**, fetching
the `app-single` bundle on demand and caching it under the `.telo` cache root — the
CLI bundles no UI bytes (see Scripts). `--debug` is the separate, network-free path:
it only writes the `.telo.debug.jsonl` event log.

## Surface

```ts
// Logic — framework-agnostic, browser-safe
import { connectDebugStream, matchesFilter, distinctSuffixes, isWireRef, eventSuffix,
         isLogFrame, endpointHref, type DebugFrame, type EventFilter,
         type AppEndpoint } from "@telorun/debug-ui";

// React components — for the standalone app and the editor panel
import { DebugWatcher, DebugPanel } from "@telorun/debug-ui/components";
// Standalone (owns its SSE + buffer; fetches `appEndpoints` from the handshake);
// theme defaults to "system":
//   <DebugWatcher url="http://localhost:9230/events" theme="system" />
// Controlled (editor feeds frames it sourced itself, injects its own terminal as
// the Logs tab, passes its own resolved theme + the app's run endpoints):
//   <DebugPanel frames={frames} status={…} paused={…} onTogglePause={…} onClear={…}
//               resolveBlobUrl={…} logsSlot={<Terminal/>} endpoints={…} theme="dark" />
```

## Scripts

- `pnpm --filter @telorun/debug-ui build` — builds both the multi-file standalone
  app (`app-dist/`) and the self-contained single-file app (`app-single/index.html`).
  The single file is what the CLI fetches on demand (hosted on npm, delivered via
  jsDelivr) and serves; in the monorepo the CLI resolves it directly from this
  package, so a local build is testable without any network.
- `pnpm --filter @telorun/debug-ui test` — unit tests (filter logic).
