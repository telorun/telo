---
"@telorun/templating": minor
"@telorun/cli": patch
---

**CEL gains `merge(map, map)`, right-hand precedence.** The map case had no
spelling at all — `+` joins lists and strings and refuses maps — so a child kind
inheriting a map-valued field could only REPLACE it. That turns a default the
parent set for a reason into something every consumer must restate, and a
consumer who restates it incompletely gets a system that works until the omitted
entry matters: an OAuth client whose `access_type: offline` was dropped issues a
refresh token until the first hour is up, and then does not. `merge(defaults,
overrides)` makes adding to a map the short spelling and replacing it the
deliberate one. Maps only, since `+` already concatenates lists; a list argument
is named rather than coerced. The generated CEL reference picks it up from the
catalog, so the docs need no separate edit.

**`telo module digest --help` says which digest it prints.** It is a
transport-specific change-detection token — for an `oci://` ref, the registry's
own digest over the OCI manifest (`sha256:<hex>`) — and NOT the
`#sha256-<base64url>` an `imports:` entry pins with, which hashes `telo.yaml`.
The two are not inter-convertible, and only the local-path branch happens to emit
the pin form, so the command looked like a pin source from one direction and not
the other. The help line now says so and points at `telo upgrade`, which is what
writes a pin. A value that looks like the one you want is worse than no value.
