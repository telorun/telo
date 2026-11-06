# Principal

`Auth.Principal` is the one description of an authenticated caller. It is closed (no other members) and **every member is required**: a verifier fills what it does not know with an empty list or `null`, so a policy or a handler reads any member without a presence check. "No principal" is a `null` principal where the transport allows anonymous callers, never a principal of an anonymous kind.

| Member | Type | Meaning |
| --- | --- | --- |
| `subject` | string | Stable identifier of the caller. Exported on the dispatch span as `enduser.id`. |
| `issuer` | string or null | The authority that vouched for the caller. |
| `kind` | `user` \| `service` | A person or a service. |
| `claims` | object | The verifier's raw claims, for what the other members do not name. |
| `scopes`, `roles`, `permissions` | string array | What the credential grants; empty when unknown. |
| `org` | string or null | The organization the caller acts for. |
| `amr` | string array | Authentication methods used (RFC 8176 values). |
| `acr` | string or null | The authentication context class reached. |
| `sessionId` | string or null | The session the request belongs to. |
| `authenticatedAt` | timestamp or null | When the caller last authenticated. |
| `via` | string | The name of the verifier that accepted the credential. |

A verifier maps its source's claims into these members; anything it does not map stays reachable through `claims`.
