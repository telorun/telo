---
"@telorun/analyzer": patch
---

Stop the module graph declaring a port for a slot nothing can fill.

`Http.Server` drew `notFoundHandler` twice — once wired to its handler, once as
an empty socket that refused every drop. A port is a place a value is or could
be written, and that second one was neither: `notFoundHandler` carries two ref
slots, `invoke` and an `encoder` the `returns:` schema pulls in through
`x-telo-schema-from` at `returns[].content.{}.encoder`, and a slot nested past
an array and a map has no write site until the item and the key exist. Rail
ports are grouped under their top-level property and drawn one line per port, so
the dead slot surfaced as a second, identical, unfillable `notFoundHandler`.

`buildPorts` already declined to invent a write site for those shapes, and
`appendPathFor` already declined to offer one — the port was emitted anyway. It
is now dropped when it is neither occupied nor fillable, which is the rule the
synthesis comment had stated all along ("it offers an affordance and then
refuses"), applied to the port rather than only to the path.

Emptiness is what decides, never the shape of the path: an encoder somebody
actually wrote keeps its port and its edge, and `mounts[].mount` on a server
with no mounts keeps its empty port, because one array deep the append path is
determined.
