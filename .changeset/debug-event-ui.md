---
"@telorun/debug-ui": minor
"@telorun/cli": minor
---

Add a live debug-event inspection UI. `telo run --inspect` starts a
localhost-only inspection endpoint and prints its URL — a single page that
watches the kernel event stream in real time (SSE), with text/kind/suffix
filtering, expandable payloads, pause, and replay of events that fired before
the page was opened. (`--debug` independently writes the `.telo.debug.jsonl`
event log; the two compose. See the `--inspect` flag set for delivery details.)

New `@telorun/debug-ui` package: the browser-safe, runtime-agnostic consumer
surface — the debug wire-format types + JSON Schema, filter logic, an SSE client,
and React components (incl. the standalone app served by the inspection server).
It has no Node-only dependency so it also runs in the editor webview.

Binary payloads (images and any other file kind) are not inlined: the producer
offloads each `Uint8Array`/`Buffer` to an in-memory, content-addressed LRU blob
store and emits a small `{ "$blob": "blobs/<id>", "mediaType", "byteLength" }`
pointer in its place (the key it sits under is preserved). The `DebugServer`
serves the bytes at `GET /blobs/:id`; the UI renders `image/*` inline and other
types as download links. Content addressing dedupes repeated buffers (e.g. a
redraw loop).

The producer (serializer + `DebugServer` + blob store) stays Node-side in the
CLI; the cross-runtime contract is the wire format
(`@telorun/debug-ui/wire-schema.json`), so a future Rust/Go kernel can serve the
same UI by conforming to it. The inspection server binds `127.0.0.1` and is
`unref`'d, so a one-shot `--inspect` run still exits normally.
