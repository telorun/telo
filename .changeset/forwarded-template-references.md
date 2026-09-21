---
"@telorun/kernel": patch
"@telorun/analyzer": minor
---

Forward references through a template body

A template body may hand a whole value holding references to an entry with a
bare `!cel "self.<path>"` — `routes: !cel "self.routes"`, where each route's
`handler` is a reference the instance declared. The router received each handler
as a live instance and failed at create with `JSON.stringify cannot serialize
cyclic structures`; the kernel now names an injected instance by the declaration
it was created from, and a malformed slot value no longer crashes the error that
reports it.

`telo check` reports `TEMPLATE_REF_COMPUTED` when a `!cel` expression that is not
a bare `self.<path>` sits at or above a reference slot inside a template entry.
CEL values are data, so such an expression passed `telo check` and failed at boot
with `Unsupported type`.
