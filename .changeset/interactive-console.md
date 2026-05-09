---
"@telorun/docker-runner": minor
---

Live PTY console for the editor's run view (xterm.js + WebSocket).

- Containers spawn with `Tty: true` + `OpenStdin: true` and a hijacked attach duplex; PTY bytes flow through a single per-session byte ring buffer instead of demuxed stdout/stderr events.
- New WebSocket route `GET /v1/sessions/:id/io` carries raw bytes both directions plus `{type:"resize",cols,rows}` control frames. `?lastSeq=<n>` resumes from the byte buffer with a `gap` diagnostic when the runner's tail evicted older bytes.
- The upgrade handler runs an explicit Origin allowlist check before completing the handshake — `@fastify/cors` does not intercept WebSocket upgrades, so this is a defense-in-depth requirement, not a convenience.
- Status events on `GET /v1/sessions/:id/events` are unchanged; the SSE path now never carries `stdout` / `stderr` event payloads.

The matching browser editor (`apps/telo-editor`) consumes the new channel via xterm.js. The Tauri build of the editor runs the same xterm host against `docker run -it` directly through Tauri channels and resize commands.
