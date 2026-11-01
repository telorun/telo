---
"@telorun/kernel": patch
---

A bare `self.<path>` that continues past a reference — in a template body, in a `base:`, `inputs:` or `result:` mapping of a kind extending another, and a repeat's bare `each.value.<path>` — now reads only what the referenced resource was declared with, never a member of its instance, so it hands on the value `telo check` judged. A controller method or property named like a declared field (`collection()` beside a declared `collection`) no longer shadows the field, and past a kind extending another with `base:` the path reads that kind's own fields instead of the mapping onto its parent, where a field such as `title` read as missing at boot. An instance with no recorded declaration is refused as `ERR_FATAL`.

A kind that forwards its configuration — a templated kind, or one extending another with `base:` — now receives its own `x-telo-eval: accessor` fields as written, so a chain its consumer writes there (`label: !cel "row.name"`) reaches the kind it is forwarded to as the chain and is bound there, instead of arriving as an already-made binding that kind refused at boot. A value there that is no plain chain is still refused at the forwarder.
