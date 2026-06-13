# Debug Logs + Editor Embed

Builds on [debug-event-ui.md](./debug-event-ui.md), which shipped the event-only
debug stream (CLI `DebugServer` + `@telorun/debug-ui` standalone). Two gaps remain:

1. **debug-ui shows events but not logs.** A run's stdout/stderr never reaches the
   stream, so the standalone UI can't replace `console`-watching.
2. **The editor can't embed it.** The editor runs a manifest through a *runner*
   (docker / Tauri) that is **out-of-process from the kernel** and only sees raw
   PTY bytes — it has no kernel event tap.

Goal: one **unified producer** emits both kinds of frame; `@telorun/debug-ui`
renders a **Logs / Events** tab split; both the standalone UI and an embedded
editor panel consume the same stream.

## The unifying insight

There is exactly one producer — the `telo` process (in the editor's case, the
`telo` running *inside* the runner's container). It already taps the kernel
(`kernel.on("*")`); we add a stdout/stderr **tee** beside that tap, contained in
the same process. It emits **one wire stream** carrying two discriminated frame
kinds. Everything downstream consumes that one stream:

- **standalone (`telo run --inspect`)** → debug-ui served by `DebugServer`.
- **editor** → the runner launches `telo --inspect <host>:<port>`, subscribes to
  its SSE, and relays each frame to the editor as a new `RunEvent` variant over
  the *existing* run transport. debug-ui is embedded as components, fed that
  buffered frame array.

## Wire contract — `@telorun/debug-wire` (new package)

The event frame today lives only in `@telorun/debug-ui` and the CLI serializer.
Promote the **frame contract** to a small neutral package so `runner-core` (Node,
must not depend on a UI package) and the editor share it without a wrong-direction
dependency. Scope is **only the frames + schema** — not the HTTP endpoint surface
(that stays the "inspect" contract, layered on top; can become its own package
later).

```ts
export interface DebugEventFrame {
  kind: "event";
  timestamp: string;          // ISO-8601
  event: string;              // dotted name, e.g. Http.Api.Invoked
  payload?: unknown;          // wire-encoded (refs → {kind,name}, bytes → blob ptr, …)
  metadata?: Record<string, unknown>;
}
export interface DebugLogFrame {
  kind: "log";
  timestamp: string;
  stream: "stdout" | "stderr";
  line: string;               // one line, ANSI preserved
}
export type DebugFrame = DebugEventFrame | DebugLogFrame;
```

- Move `wire.ts` types + `wire-schema.json` here; debug-ui re-exports from it.
- `kind` is the discriminator (decision: **separate log frame**, not a log-shaped
  event). Both sinks (`--debug` file, `--inspect` server) emit the union.
- Browser-safe, zero Node imports — consumable by debug-ui, cli, runner-core, editor.

## Phase A — logs in the wire + tabbed debug-ui

The self-contained win: `telo run --inspect` standalone shows both tabs.

1. **`@telorun/debug-wire`** — extract the frame union + schema as above; stamp
   existing events with `kind: "event"`.
2. **CLI tee, contained in the `telo` process.** In `startDebugSession`
   ([run.ts](../cli/nodejs/src/commands/run.ts)) wrap `process.stdout.write` /
   `process.stderr.write`: pass through to the real stream (terminal unaffected),
   line-buffer, and fan each completed line as a `DebugLogFrame` into the existing
   sinks (`fileSink` + `server.push`). Restore the originals on `stop()`. Only
   active while the debug session is on. Add `serializeLog` beside `serializeEvent`
   in [debug-serialize.ts](../cli/nodejs/src/debug-serialize.ts).
3. **debug-ui tabs.** [DebugWatcher](../packages/debug-ui/src/components/DebugWatcher.tsx)
   keeps two buffers keyed by `kind` and renders a Logs / Events toggle. Events tab
   = today's `EventTable` + `FilterBar`. Logs tab = a line view (timestamp · stream ·
   line, ANSI-rendered, autoscroll/pause). [sse-client.ts](../packages/debug-ui/src/sse-client.ts)
   routes parsed frames by `kind`.

## Phase B — editor embed

The editor consumes the workload's debug stream as `debug` `RunEvent`s and renders
them in a Debug tab. How those frames are *sourced* splits by runner, following
the security boundary — but RunView consumes them identically either way:

- **Remote HTTP / k8s runners** relay frames through the runner over the existing
  `/v1/sessions/:id/events` transport. The runner is the security/ingress boundary;
  the workload's `--inspect` port stays reachable only by the runner, never exposed.
- **Local Tauri runner** (all-loopback, single-user — no ingress/exposure concern)
  publishes the workload's `--inspect` port to `127.0.0.1` and the editor adapter
  reads it directly, converting frames to the same `debug` `RunEvent`s. This avoids
  a Rust HTTP/SSE client (the Tauri crate has none).

1. **`RunEvent` gains a debug variant.** Add `{ type: "debug"; frame: DebugFrame }`
   to [runner-core/contract.ts](../packages/runner-core/src/contract.ts) and the
   mirrored editor [run/types.ts](../apps/telo-editor/src/run/types.ts). Decode it
   in [http-runner/sse-client.ts](../apps/telo-editor/src/run/adapters/http-runner/sse-client.ts);
   emit + decode the matching Tauri event in
   [docker.rs](../apps/telo-editor/src-tauri/src/run/docker.rs) +
   [tauri-docker/adapter.ts](../apps/telo-editor/src/run/adapters/tauri-docker/adapter.ts).
   SSE serialization ([sse/channel.ts](../packages/runner-core/src/sse/channel.ts))
   is already generic over `RunEvent`.
2. **Launch + subscribe.** Both runners launch `telo` with `--inspect 0.0.0.0:9230
   --no-open` (`0.0.0.0`, not the CLI loopback default, so the port is reachable
   across the container boundary). docker-runner reaches it by container name over
   the child network (`relayDebugStream` in runner-core — `fetch` SSE client, retries
   until ready, aborts on session end) and relays via `onDebug`. The Tauri runner
   publishes `-p 127.0.0.1:<free>:9230` and announces the URL on a
   `run:<id>:debug-endpoint` event; the adapter opens an `EventSource` to it. The
   `DebugServer` adds permissive CORS so the embedding webview can read it.
3. **Editor embeds debug-ui.** Add `@telorun/debug-ui` as an editor dep.
   [RunRecord](../apps/telo-editor/src/run/context.tsx) grows a debug-frame buffer
   beside `lines`. [RunView](../apps/telo-editor/src/run/ui/RunView.tsx) renders the
   debug-ui `DebugPanel` (fed the in-memory frame array) in a Debug tab alongside
   the Output tab.

## Notes / edge cases

- **Line buffering** the tee: hold partial writes until `\n`; flush remainder on
  teardown so a no-newline final write isn't dropped.
- **Console.WriteLine double-signal:** it both writes to stdout (→ a log frame via
  the tee) and emits `StdOut.LineWritten` (→ an event frame). Acceptable — they land
  in different tabs; revisit only if noisy.
- **Secrets:** logs can carry secrets just like event payloads — the inspect server
  stays bound to the concrete host the runner controls; never a public interface.
- **Backend spread:** Tauri (local docker) publishes the inspect port to host
  loopback and the editor reads it directly; docker-runner reaches it by container
  name over the child network and relays. Both surface identical `debug` run events.
- **Blobs in the editor embed (follow-up):** the standalone UI resolves `$blob`
  pointers against the producer origin, but the editor can't reach the workload's
  blob endpoint (HTTP relay: only the runner can; Tauri: the origin is lost when
  frames become run events). So image/PDF payloads don't render in the editor yet —
  events + logs work. A runner-side blob proxy (`/v1/sessions/:id/blobs/:id`) or
  adapter-side `$blob` URL rewriting closes this later.

## Testing

- `@telorun/debug-wire`: schema ↔ TS type round-trip; discriminator validation.
- CLI: tee captures stdout/stderr into the stream as `log` frames; terminal output
  unchanged; originals restored on stop.
- debug-ui: tab routing by `kind`; log-line rendering. Existing filter tests stay.
- Manual: `pnpm run telo --inspect ./examples/draw-shapes-agent.yaml`, confirm both
  tabs (and an inline image blob in the standalone UI); then run from the editor and
  confirm the embedded Debug tab shows logs + events.

## Release / docs

- New `@telorun/debug-wire` → changeset; debug-ui, cli, runner-core, editor
  changesets for the new dep / frame variant.
- Update the wire-format docs page (event envelope → frame union) and debug-ui
  README (the Logs tab).
