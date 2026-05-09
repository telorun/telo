# Interactive Console (xterm.js + PTY)

## Goal

Make the editor's run console fully interactive across both adapters. A user running [examples/chat-console.yaml](../../../examples/chat-console.yaml) — in the browser build against `apps/docker-runner`, or in the Tauri desktop build — should be able to type into the console, hit Enter, and have the bytes reach `Console.ReadLine` inside the running container, with colors, spinners, line editing, signals, and resize all working the way a real terminal would.

Today both runs exit ~270ms after the prompt is printed because the container is spawned with stdin disconnected. The editor side renders log lines into a virtualized list with no input affordance.

## Non-goals

- Multi-client coordination. If two tabs (browser) attach to the same session, both receive the output stream; input is first-writer-wins on the underlying PTY. Not addressed. (Tauri is single-window-per-run by design.)
- Auth / origin restriction on the WebSocket beyond what `corsOrigins` already implies for HTTP.
- Persisting scrollback across reloads. v1: a tab reload (browser) or window restart (Tauri) starts with empty xterm scrollback. Server-side replay of recent bytes is in scope on the docker-api path so a transient WS blip is recoverable; tab reload is not.
- TUI-quality features beyond what xterm.js + a Linux PTY give us out of the box (e.g. graphics protocols, sixel, kitty image protocol).

---

## Principles

1. **Use the standard browser terminal.** xterm.js (`@xterm/xterm`) is the de-facto component — same engine VS Code uses. It owns rendering, ANSI parsing, scrollback, selection, copy/paste, addons. We do not reimplement any of that. Both adapters mount it identically.
2. **PTY in the container, not pipes.** Set `Tty: true` (dockerode) / `-t` (docker CLI) on container creation. The container's stdin/stdout/stderr collapse into a single byte stream that behaves like a real terminal. This restores `readline` echoing, line editing, ANSI, and signal semantics for free, at the cost of merging stdout with stderr — same tradeoff every terminal makes.
3. **One capability, two transports.** `RunSession.io` is the contract `TerminalView` consumes. `docker-api` implements it over WebSocket; `tauri-docker` implements it over Tauri channels + commands. The React layer is transport-agnostic.
4. **Resilience where it's cheap.** docker-api keeps a per-session capped ring of recent output bytes for WS reconnect replay (mirrors the existing `EventRingBuffer` approach). tauri-docker doesn't need this — the Tauri side and the runner are in the same process tree, no network in the middle.
5. **No kernel or module changes.** `ctx.stdin` flowing into [modules/console/nodejs/src/readline-controller.ts](../../../modules/console/nodejs/src/readline-controller.ts) already does the right thing once the container has a real TTY on its stdio.

---

## Architecture

### Capability shape

Both adapters expose the same shape on `RunSession`:

```ts
io?: {
  open(handlers: {
    onData(bytes: Uint8Array): void;
    onClose(reason: { code: number; clean: boolean }): void;
  }): {
    send(bytes: Uint8Array): void;
    resize(cols: number, rows: number): void;
    close(): void;
  };
};
```

Optional in the type system (forward-compat for non-interactive adapters), but both shipping adapters implement it from day one. `TerminalView` mounts xterm.js when `io` is present and otherwise falls back to `LogStream` (legacy display).

### docker-api (browser)

```
┌────────────────────────────────────────────────────────────────┐
│ Browser                                                        │
│   TerminalView ─▶ xterm.js + FitAddon + WebLinks               │
│                     onData(bytes) ─┐                           │
│                     write(bytes)  ◀┤                           │
│                     onResize     ──┤                           │
│                                    ▼                           │
│   docker-api adapter ─▶ io-client (WebSocket)                  │
│                       └─ status: SSE (existing, unchanged)     │
└────────────────────────────────────────────────────────────────┘
            │                                       ▲
            │ /v1/sessions/:id/io  (WS, bytes)      │
            │ /v1/sessions/:id/events (SSE, status) │
            ▼                                       │
┌────────────────────────────────────────────────────────────────┐
│ apps/docker-runner (Fastify)                                   │
│   io WS handler ─▶ session.ptyInput (Writable)                 │
│   resize control ─▶ container.resize({h, w})                   │
│   byte ring buffer ─▶ replay on WS reconnect                   │
│                                                                │
│   dockerode createContainer({ Tty: true, OpenStdin: true })    │
│   dockerode attach({ stream, stdin, stdout, stderr, hijack })  │
│            └─▶ single duplex socket = the PTY byte stream      │
└────────────────────────────────────────────────────────────────┘
```

### tauri-docker (desktop)

```
┌────────────────────────────────────────────────────────────────┐
│ Tauri webview                                                  │
│   TerminalView ─▶ xterm.js (identical mount)                   │
│   tauri-docker adapter ─▶ io-client (Tauri channel + invoke)   │
└────────────────────────────────────────────────────────────────┘
            │                                       ▲
            │ invoke("run_send_input", bytes)       │ Channel<Vec<u8>>
            │ invoke("run_resize", {cols, rows})    │ run:${id}:status (Tauri event)
            ▼                                       │
┌────────────────────────────────────────────────────────────────┐
│ apps/telo-editor/src-tauri (Rust)                              │
│   docker run --rm -it (PTY merged stream)                      │
│      ChildStdin  ◀─── run_send_input writes bytes              │
│      ChildStdout ───▶ reader task → Channel<Vec<u8>>           │
│   docker resize <container> --height H --width W (per resize)  │
└────────────────────────────────────────────────────────────────┘
```

The two transports differ only in plumbing. The byte semantics, control-frame semantics (resize), and lifecycle (open / send / resize / close) are identical.

### PTY mode tradeoffs (accepted on both adapters)

- stdout and stderr merge. `chat-console.yaml` and `Console.WriteStream` already write only to stdout, so user-visible output is unchanged. Diagnostic logs that today land on stderr appear interleaved on the merged stream with no styling distinction. Acceptable: production debugging is not the editor's job, and tests still capture demuxed output by going through the CLI path.
- `FORCE_COLOR=1` / `CLICOLOR_FORCE=1` env injection becomes redundant (TTY is true), but harmless. Leave for now.
- Container exit signals propagate. Ctrl-C from xterm sends `0x03` over stdin → kernel's signal handling in the child process applies. No SIGINT plumbing needed in either runner.

---

## I/O channel — docker-api

URL: `ws[s]://<runner>/v1/sessions/:id/io?lastSeq=<n>`

- **Client → server frames**:
  - Binary frame: raw bytes to write to the PTY input. xterm's `onData` fires per keystroke / paste; sent as UTF-8 bytes.
  - Text frame `{"type":"resize","cols":N,"rows":N}`: forwarded to `container.resize({h: rows, w: cols})`. Throttled in the client (50ms trailing) since `FitAddon` can fire rapidly during window drag.
- **Server → client frames**:
  - Binary frame: bytes read from the PTY. Sequence number assigned per send (monotonic per session).
  - Text frame `{"type":"seq","seq":N}` only at WS open if `lastSeq` was supplied — confirms the resume point. Bytes after this are replayed.
- **Close codes**: `1000` clean, `4404` session unknown, `4410` session terminal at WS open with no replayable bytes.

## I/O channel — tauri-docker

The Tauri adapter implements the same `io` contract using Tauri-2 primitives — no WebSocket. The Rust side spawns `docker run --rm -it` and holds:

- `ChildStdin` — written to by the `run_send_input` command.
- A reader task on `ChildStdout` that pushes byte chunks into a `tauri::ipc::Channel<Vec<u8>>`. Channels are the v2 way to stream binary from Rust to webview without per-event JSON cost.

Webview-side commands:

- `invoke("run_send_input", { sessionId, bytes: Uint8Array })` — bytes deserialize as `Vec<u8>` server-side; the handler locks `ChildStdin` and writes.
- `invoke("run_resize", { sessionId, cols, rows })` — handler shells out to `docker resize <container> --height <rows> --width <cols>`. Throttled 50ms server-side too (last write wins within the window). Skipped if the container is already in a terminal status.
- `invoke("run_close_input", { sessionId })` — drops `ChildStdin`, signalling EOF. Idempotent.

**Channel construction order is load-bearing.** The webview constructs the channel with its `onmessage` handler attached at construction time — the Tauri 2 idiom is `new Channel<Uint8Array>(handler)` — and *then* invokes `run_start` with the constructed channel as one of its parameters. Tauri auto-routes the channel id across the IPC boundary. The Rust reader task starts emitting bytes the moment `tokio::process::Command::spawn` returns, which is **before** `run_start` resolves on the JS side. Wiring `onmessage` after `await invoke("run_start", …)` would silently drop every byte produced during start-up — the same race the existing status-event listeners already avoid by registering before `run_start` (see the comment in [src/run/adapters/tauri-docker/adapter.ts:66-68](../src/run/adapters/tauri-docker/adapter.ts#L66-L68)). The channel construction site therefore lives in the io-client, executed before the start invoke.

---

## Concrete changes

### `apps/docker-runner`

**[src/docker/run-session.ts](../../docker-runner/src/docker/run-session.ts)**

- `CreateContainerOpts`: add `Tty: true`, `OpenStdin: true`, `StdinOnce: false`.
- **Update the `SessionDockerContainer.attach` signature itself.** Current shape is `(opts: { stream: true; stdout: true; stderr: true; logs: true }) => Promise<NodeJS.ReadableStream>`. New shape is `(opts: { stream: true; stdin: true; stdout: true; stderr: true; hijack: true; logs?: true }) => Promise<NodeJS.ReadWriteStream>` — dockerode's typed return for hijacked attach is a duplex. Until this interface is updated the rest of the wiring won't typecheck.
- `attachContainer`: switch to hijacked attach with the new flag set. The returned duplex's writable side is exposed on `SpawnResult` as `ptyInput: NodeJS.WritableStream`; the readable side feeds `wirePty`.
- New `wirePty` replaces `wireStdio`. Reads bytes from the duplex; pushes to `onByteChunk(chunk: Buffer)`. No `demuxStream`.
- New helper `resizeContainer(container, cols, rows)` wraps `dockerode.Container#resize`.
- `SessionDockerContainer` interface gains `resize(opts: { h: number; w: number }): Promise<unknown>`. Both fake implementations need updating: `FakeContainer` in [docker-runner/src/test-helpers.ts](../../docker-runner/src/test-helpers.ts#L33) (whose `attach` at line 98 currently returns a `PassThrough`), and the inline mock in [docker-runner/src/routes/sessions.test.ts](../../docker-runner/src/routes/sessions.test.ts) around lines 362–379. Their fake `attach` must accept the new flag shape and return a `Duplex` (a hand-rolled `Duplex.from({ readable, writable })` over two `PassThrough`s is the path of least resistance — write side feeds the readable that the test asserts on, read side absorbs writes from `ptyInput`).
- `SpawnResult.exit` end-handler must `ptyInput.end()` if not already ended.

**[src/session/registry.ts](../../docker-runner/src/session/registry.ts)**

- `SessionEntry` gains:
  - `ptyInput: NodeJS.WritableStream | null` — set by `spawnSession`.
  - `byteBuffer: ByteRingBuffer` — bounded by bytes (mirrors `replayBufferBytes` config, separate instance from the existing event buffer).
  - `byteSeq: number` — monotonic.
  - `byteEmitter: EventEmitter` — single `"chunk"` event carrying `{ seq, bytes }`.
- New methods on `SessionRegistry`: `pushBytes`, `subscribeBytes`, `replayBytes(lastSeq) -> { entries, hasGap }`. Same eviction-with-gap semantics as the existing event buffer.

**[src/session/byte-ring-buffer.ts](../../docker-runner/src/session/byte-ring-buffer.ts)** *(new)*

Mechanically a clone of [event ring buffer](../../docker-runner/src/session/ring-buffer.ts) but storing `Buffer` slices keyed by `seq`, capped by total resident bytes. Unit test alongside.

**[src/routes/sessions.ts](../../docker-runner/src/routes/sessions.ts)**

- New WS handler at `GET /v1/sessions/:id/io` (Fastify upgrades via `@fastify/websocket`). On upgrade:
  - **Origin check is mandatory inside this handler.** `@fastify/cors` does not intercept WebSocket upgrades — its hooks run inside the regular reply pipeline, which the upgrade bypasses. Read `req.headers.origin` directly and reject (close `4403`) any origin not in `corsOrigins`. Without this, any browser origin can open a PTY input channel into a live session — a real auth bypass.
  - 404 → close `4404`. Session terminal AND no replayable bytes → close `4410`.
  - Send confirming `{type:"seq",seq:lastSeq}` text frame. Replay buffered bytes > `lastSeq`. Subscribe to live `byteEmitter`.
  - Binary frame from client → `entry.ptyInput.write(buf)`. Text frame → parse, `resize` → `entry.container.resize({h: rows, w: cols})`. Server-side resize throttle 50ms (last write wins).
  - On WS close: unsubscribe; do not end `ptyInput` (other clients / future reconnects may write).
- Existing SSE `GET /v1/sessions/:id/events` unchanged. It now never carries bytes — only `status` and `gap`.

**[src/server.ts](../../docker-runner/src/server.ts)**

- Register `@fastify/websocket`.
- `package.json`: add `@fastify/websocket`.

**Tests**

- `byte-ring-buffer.test.ts` — push, replay with `lastSeq`, gap detection, byte-cap eviction.
- `sessions.test.ts` extension — WS open + replay + binary write; mock `dockerode` `attach` to return a hand-rolled `Duplex` so the test reads what the test wrote.
- **WebSocket tests cannot use `app.inject()`.** Fastify's in-memory inject path does not implement the HTTP upgrade handshake. WS tests must drive a real `app.listen(0)` (ephemeral port) and connect with the `ws` package's client. The existing `inject`-based harness stays for HTTP routes only.
- Origin-check coverage: WS open with a disallowed origin closes `4403` before any frames flow.
- e2e: one-line readline manifest, send `"hi\n"` over WS, assert echo arrives back as bytes.

### `apps/telo-editor/src-tauri` (Rust runner)

**[src-tauri/src/run/docker.rs](../src-tauri/src/run/docker.rs)**

- Replace `cmd.arg("run").arg("--rm").arg("-i")` with `…--rm -it…`. The `-t` allocates a PTY on the container.
- Replace `cmd.stdin(Stdio::null())` with `cmd.stdin(Stdio::piped())`. Take `child.stdin` after spawn.
- Keep `cmd.stderr(Stdio::piped())` and **keep a draining stderr reader task**. With `-t` the *container's* stderr is merged onto stdout, but the *docker CLI itself* still writes its own diagnostics (pull progress, image-not-found, daemon errors) to stderr. Without a draining reader the 64 KB pipe fills and the docker CLI blocks; switching to `Stdio::null()` instead would silently swallow start-failure messages the user needs to see. Both reader tasks (stdout and stderr) push into the **same** `tauri::ipc::Channel<Vec<u8>>` — in normal operation the docker-CLI stderr is empty, in failure modes those bytes appear inline in the terminal (closest analogue to running `docker run` in a real shell).
- The merged byte source replaces the previous `OutputChunk` event payload (today JSON `{chunk: String}`). All bytes flow as raw `Vec<u8>` via `tauri::ipc::Channel::send`. The existing `run:${sessionId}:stdout` / `:stderr` Tauri events are removed.
- Existing env injection (`FORCE_COLOR=1` etc.) stays — harmless under PTY mode.

**[src-tauri/src/run/session.rs](../src-tauri/src/run/session.rs)**

- `SessionEntry` gains:
  - `stdin: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>` — `Option` so `run_close_input` can consume it.
  - `byte_channel: tauri::ipc::Channel<Vec<u8>>` — the channel handed to the webview at start, used by the stdout reader task.
- New helper `kill_info` already exists; mirror `stdin_handle` accessor for the input-write command.

**[src-tauri/src/run/mod.rs](../src-tauri/src/run/mod.rs)**

- `run_start` signature gains `io_channel: tauri::ipc::Channel<Vec<u8>>` — the webview constructs the channel with its `onmessage` handler attached at construction, then passes it as a parameter (Tauri auto-routes channel id resolution). This is an internal IPC contract between the webview bundle and the Rust sidecar; both ship in lockstep within the same app build, so no external migration story is needed beyond updating both sides in the same change.
- New commands:
  - `run_send_input(session_id: String, bytes: Vec<u8>)` — locks the `stdin` Mutex, writes, flushes. Errors mapped to `String` for Tauri's error path.
  - `run_resize(session_id: String, cols: u16, rows: u16)` — invokes `docker resize <container_name> --height <rows> --width <cols>`. Server-side throttle: a per-session `Mutex<Option<JoinHandle>>` debounces 50ms.
  - `run_close_input(session_id: String)` — takes the `stdin` Option, drops it.
- `kill_all_on_close` unchanged.

### Editor (`apps/telo-editor`)

**[src/run/types.ts](../src/run/types.ts)**

- Add the `io` capability to `RunSession` (shape shown earlier — optional in the type, present on both shipping adapters).

**[src/run/adapters/docker-api/io-client.ts](../src/run/adapters/docker-api/io-client.ts)** *(new)*

- Manages the WebSocket lifecycle for a session.
- Persists `lastSeq` in `sessionStorage` keyed by session id (mirrors how `sse-client.ts` persists `lastEventId`).
- Exponential backoff reconnect on closes outside `[1000, 4404, 4410]`. Surfaces a single dim-line gap notification to xterm when the server reports a replay gap.
- Resize debounced 50ms trailing.

**[src/run/adapters/docker-api/adapter.ts](../src/run/adapters/docker-api/adapter.ts)**

- Compute the WS URL from `config.baseUrl` (`http`→`ws`, `https`→`wss`, append `/v1/sessions/<id>/io`).
- Implement `RunSession.io` by constructing the io-client lazily on `open`. SSE client unchanged.

**[src/run/adapters/tauri-docker/io-client.ts](../src/run/adapters/tauri-docker/io-client.ts)** *(new)*

- Constructs the Tauri channel **with the handler attached at construction**: `new Channel<Uint8Array>(bytes => onData(bytes))`. *Only after that* invokes `run_start({ …, ioChannel })`. This ordering is mandatory: bytes the Rust reader emits between `Command::spawn` and the JS receiving its first message would be dropped if the handler were attached after `await invoke(...)` resolves.
- `send(bytes)` → `invoke("run_send_input", { sessionId, bytes: Array.from(bytes) })` (Tauri channels + invoke marshal `Uint8Array`/`Vec<u8>` natively in v2; if a particular Tauri version regresses we fall back to base64).
- `resize(cols, rows)` → `invoke("run_resize", { sessionId, cols, rows })`. Debounced 50ms client-side.
- `close()` → `invoke("run_close_input", { sessionId })`.

**[src/run/adapters/tauri-docker/adapter.ts](../src/run/adapters/tauri-docker/adapter.ts)**

- Wire the io-client into `RunSession.io`. The existing stdout/stderr Tauri-event listeners become unused for this adapter and are removed; status listener stays.

**[src/run/ui/TerminalView.tsx](../src/run/ui/TerminalView.tsx)** *(new)*

- Mounts xterm.js imperatively in `useEffect` against a ref-held `<div>`. No React wrapper package — they are thin.
- Addons: `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-canvas` (with DOM fallback if canvas init fails).
- On mount: `io.open({ onData: bytes => term.write(bytes), onClose: showClosedOverlay })`. Wire `term.onData(s => io.send(encoder.encode(s)))` and `FitAddon`/window-resize → `io.resize`.
- On terminal status: detach `onData` so input is rejected client-side; keep the terminal visible for scrollback.

**[src/run/ui/RunView.tsx](../src/run/ui/RunView.tsx)**

- If `activeRun.session.io` exists → render `<TerminalView>` filling the body. Both shipping adapters take this branch from day one. The `<LogStream>` fallback path remains for any future non-`io` adapter.

**`package.json`** — add `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`, `@xterm/addon-canvas`.

---

## Test plan

1. **`examples/chat-console.yaml` end-to-end, browser build.** Type, see streamed reply with spinner clearing, repeat, `/exit` cleanly.
2. **`examples/chat-console.yaml` end-to-end, Tauri build.** Same script; identical UX from the user's seat.
3. **Smoke manifest** — single `Console.ReadLine` → `Console.WriteLine` echo. Round-trips a known string. Run on both adapters.
4. **Resize.** Drag editor window: `FitAddon` + adapter resize → `bash` inside a generic image reports new `$LINES`/`$COLUMNS`. Run on both adapters (different code paths: `dockerode.resize` vs `docker resize` CLI).
5. **Signals.** `sleep 60`; Ctrl-C in the terminal kills the process, status flips to `exited` with non-zero code. Both adapters.
6. **Reconnect (browser only).** Stop the runner mid-run, restart it within retry window — confirm WS reconnect, gap notification, resumed bytes. Tauri has no equivalent transient-disconnect mode.
7. **Tab reload (browser) / window reopen (Tauri).** Fresh terminal, status backfills from existing replay (browser SSE / Tauri status event), bytes do not.
8. **Stop button.** Press Stop mid-prompt: terminal freezes after final bytes flush, status flips to `stopped`. Both adapters.
9. **Runner unit tests.** Byte ring buffer, WS handler (open/replay/write/resize/close), mocked dockerode duplex.
10. **Tauri command unit tests.** `run_send_input` writes to a fake `ChildStdin`; `run_resize` shells out (mocked); `run_close_input` drops the handle and is idempotent.

---

## Migration notes

- Both adapters implement the same `RunSession.io` capability from day one. The optionality on the type is forward-compat for future non-interactive adapters; UI branches on its presence.
- `RunEvent.stdout` / `RunEvent.stderr` variants stay in the union for now (anything subscribing to `session.subscribe` keeps compiling), but neither shipping adapter emits them after this change. The `LogStream` path in `RunView` remains as a fallback for any non-`io` adapter that might land later. Removing the unused variants is a separate cleanup once we're sure no consumer relies on them.
- **Changesets.** This change touches `@telorun/docker-runner` and `apps/telo-editor` (and the Tauri sidecar). Add one `.changeset` entry covering all affected published packages.
