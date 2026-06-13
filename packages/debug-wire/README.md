# @telorun/debug-wire

The Telo **debug wire format** — the language-neutral frame contract that flows
between a kernel runtime (the producer) and every consumer of its debug stream.

A single stream carries two discriminated frame kinds:

- `kind: "event"` — a kernel event (`Server.Listening`, `MyKind.MyName.Invoked`, …).
- `kind: "log"` — one line of the runtime's stdout/stderr.

Consumers route on `kind`; a frame with no `kind` is treated as an event, so a
legacy event-only stream still parses.

This package is intentionally tiny and **browser-safe** (no Node built-ins, no
framework). It is the shared seam so the CLI producer, the runner that relays the
stream, the editor, and `@telorun/debug-ui` all agree on the shape without a
wrong-direction dependency on a UI package.

[`wire-schema.json`](./wire-schema.json) is the source of truth a non-TypeScript
producer (a future Rust/Go kernel) conforms to; the TypeScript types here are its
projection.

## Surface

- Types: `DebugFrame` (= `DebugEvent | DebugLog`), `DebugEvent`, `DebugLog`,
  `WireRef`, `WireBlob`.
- Guards: `isLogFrame`, `isEventFrame`, `isWireRef`, `isWireBlob`.
- Helper: `eventSuffix(event)` — the trailing segment of a dotted event name.
