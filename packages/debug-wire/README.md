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

## Kernel events a host may depend on

The dotted event vocabulary inside an `event` frame is open — a kind emits
`<Name>.Invoked`, `<Name>.Listening` and whatever else it has to say, and no
consumer is obliged to know any of them. These four are the exception: a HOST
(the runner that stands a workload up and routes traffic to it) derives observable
behaviour from them, so a kernel that does not emit them leaves that host with no
run outcomes and no way to re-route a port. They are listed here rather than left
to one implementation because a second runtime has to be able to implement
against them.

| Event | Payload | What a host does with it |
| --- | --- | --- |
| `Kernel.Starting` | — | Opens a run generation. |
| `Kernel.Stopped` | `{ exitCode: number }` | Closes it, carrying the code. |
| `Kernel.RunFailed` | `{ phase: "load" \| "start", code?: string, message: string }` | Reports a generation that never reached a running state, with the diagnostic code where there is one. Emitted where `Kernel.Starting` never fires (a manifest that fails to LOAD) or fires and is never followed by `Kernel.Stopped` (a boot failure). |
| `Kernel.PortsResolved` | `{ ports: Array<{ name: string, port: number, protocol: "tcp" \| "udp" }> }` | Re-routes the workload. The Application's `ports:` block resolved to integers, re-emitted on every load — so a host patches its routing without re-parsing a manifest. DECLARED, not bound: whether anything is listening is a separate observation. |

A host reads these tolerantly. A payload it cannot make sense of is skipped, not
failed on: it consumes a stream from a kernel it is not versioned with.

**A stream that carries a replay buffer MUST put a monotonic `id:` on each frame
and honour `Last-Event-ID`.** Without a resume point a reconnecting consumer is
replayed history it has already seen — and a consumer that DERIVES state from the
stream (a host counting run generations) then counts it twice.

## Surface

- Types: `DebugFrame` (= `DebugEvent | DebugLog`), `DebugEvent`, `DebugLog`,
  `WireRef`, `WireBlob`.
- Guards: `isLogFrame`, `isEventFrame`, `isWireRef`, `isWireBlob`.
- Helper: `eventSuffix(event)` — the trailing segment of a dotted event name.
