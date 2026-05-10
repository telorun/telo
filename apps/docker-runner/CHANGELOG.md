# @telorun/docker-runner

## 0.3.0

### Minor Changes

- 7c092be: Live PTY console for the editor's run view (xterm.js + WebSocket).

  - Containers spawn with `Tty: true` + `OpenStdin: true` and a hijacked attach duplex; PTY bytes flow through a single per-session byte ring buffer instead of demuxed stdout/stderr events.
  - New WebSocket route `GET /v1/sessions/:id/io` carries raw bytes both directions plus `{type:"resize",cols,rows}` control frames. `?lastSeq=<n>` resumes from the byte buffer with a `gap` diagnostic when the runner's tail evicted older bytes.
  - The upgrade handler runs an explicit Origin allowlist check before completing the handshake — `@fastify/cors` does not intercept WebSocket upgrades, so this is a defense-in-depth requirement, not a convenience.
  - Status events on `GET /v1/sessions/:id/events` are unchanged; the SSE path now never carries `stdout` / `stderr` event payloads.

  The matching browser editor (`apps/telo-editor`) consumes the new channel via xterm.js. The Tauri build of the editor runs the same xterm host against `docker run -it` directly through Tauri channels and resize commands.

## 0.2.0

### Minor Changes

- 2900b1c: Added port exposure to the Run feature. The Deployment view has an "Exposed ports" editor next to "Environment variables"; both the in-process Tauri Docker adapter and the remote `@telorun/docker-runner` HTTP service publish the configured ports (`-p port:port/protocol` / Docker API `PortBindings`) when a session starts. The Run view header shows one clickable `host:port` chip per exposed port; the host is resolved from `DOCKER_HOST` (Tauri adapter) or from the runner's base URL (HTTP adapter). `RunStatus.running` now carries an optional `endpoints` array describing where the container is reachable.
