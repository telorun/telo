---
"@telorun/kernel": minor
"@telorun/analyzer": minor
"@telorun/templating": patch
"@telorun/http-server": patch
"@telorun/editor": patch
---

Add a `ports` declaration to `Telo.Application`. `ports` is a name-keyed map
(sibling of `variables` / `secrets`) where each entry binds a host env var to
an inbound port the app listens on: `{ env, protocol?, default? }`, implicitly
typed as an integer in the 1–65535 range. Values resolve at `kernel.load()` —
mirroring the variables env-resolution path, with the same
`ERR_MANIFEST_VALIDATION_FAILED` aggregation — and surface in a new
`ports.<name>` CEL scope, so a binding resource reads `${{ ports.http }}` from
a single declared source. A runner or the editor can read the exposed ports
(and the env var that configures each) before the app starts. Application-only;
`Telo.Library` does not declare ports.

Also adds `x-telo-type`, a general analyzer-only value-brand annotation. A
port's transport brands its value (`tcp → TcpPort`, `udp → UdpPort`) as a
nominal CEL type, and a resource field can declare which brand it accepts
(`http-server`'s `port` is branded `TcpPort`). Wiring a `UdpPort` into a
`TcpPort`-branded field is a static analyzer error. Brands are analyzer-only —
the value flows as a plain integer at runtime, so there is no runtime cost.

Adds an `UNUSED_DECLARATION` warning: a declared `variables` / `secrets` /
`ports` entry that no CEL expression references is flagged (a generic,
table-driven pass across the three namespaces). Application-only — a
`Telo.Library`'s `variables` / `secrets` are a controller-consumed public
contract and are not flagged.
