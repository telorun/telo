---
"@telorun/kernel": minor
"@telorun/cli": patch
---

Move the `--debug` event log out of the kernel into the CLI. The kernel no
longer monkeypatches `EventBus.emit` with an always-installed streaming wrapper;
debugging is now a plain `kernel.on("*", …)` subscriber (`DebugEventSubscriber`,
attached by the CLI only when `--debug` is set). A normal run registers no `*`
listener, so the event bus carries zero added overhead.

Serialization is cycle- and value-safe and logs only plain data. Stream-bearing
payloads (e.g. an Invocable's `{ outputs: { output: Stream } }`) whose
async-generator closures form reference cycles previously threw `cannot serialize
cyclic structures` and dropped the event. Live runtime objects — a resolved
`!ref` is a controller instance whose `.ctx` back-references the whole Kernel —
previously serialized into multi-megabyte heap dumps. Now: a resolved `!ref`
renders as the `{ kind, name }` reference it stands for; every other live object
collapses to a one-token `[ClassName]` / `[Stream]` / `[Circular]` marker;
object/array literals still log in full.

BREAKING (kernel public API): `EventStream`, `Kernel.enableEventStream`,
`Kernel.disableEventStream`, and `Kernel.getEventStream` are removed. The CLI was
the only consumer.
