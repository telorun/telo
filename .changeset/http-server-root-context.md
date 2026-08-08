---
"@telorun/http-server": patch
---

Inbound dispatch now goes through `ctx.rootContext()` — the route handler, the
`notFoundHandler`, and a `contentTypeParsers` parser all receive a context
minted for the request rather than whatever was ambient when the route was
registered.

No behaviour changes for an app today: a route handler already ran on a
per-request cancellation context, and the other two are dispatched from socket
callbacks where the ambient is empty anyway. What changes is that the guarantee
is now *stated* rather than incidental. Execution zones (`kernel/specs/execution-zones.md`
§7) make it a conformance obligation on every inbound registrant, and the
analyzer's hard error on `trigger.inbound` edges — a zone requirement reaching
an HTTP route is `ZONE_REQUIREMENT_UNSATISFIED` — rests on it holding. Before,
it held because every shipped inbound kind happens to be a `Telo.Service`,
which is a property of those kinds rather than of the edge.
