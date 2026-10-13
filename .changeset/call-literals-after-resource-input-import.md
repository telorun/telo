---
"@telorun/analyzer": patch
"@telorun/kernel": patch
---

A resource whose reference is written through an import alias is created after that import. An import that takes a resource input (`resources: { hub: !ref hub }`) is created after the resource it is handed, and a caller declared with no dependency of its own used to be created ahead of it; the plain-encoded literals of its call — an RFC 3339 instant at a `Telo.Timestamp` input, base64url text at a `Telo.Bytes` one — were then never read against the target's declaration, and the call was refused with `ERR_INPUT_INVALID`. The kernel also reads those literals again the next time such a resource is created when a call target had not resolved, instead of treating the resource as read.
