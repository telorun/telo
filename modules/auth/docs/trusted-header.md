# Auth.TrustedHeader

Accepts the identity a reverse proxy or gateway has already authenticated and forwarded. It reads only `asserted` presentations and trusts them completely, so it belongs only behind a proxy the server has been told to trust; the transport produces an `asserted` presentation only under that condition.

| Field | Meaning |
| --- | --- |
| `principalIssuer` | Recorded as the principal's `issuer`; `null` when omitted. It is not a token issuer, so the verifier declares no `issuer` and is never advertised as an authorization server. |
| `principalKind` | `user` (default) or `service`. |
| `claimNames` | The forwarded claim holding `roles`, `scopes`, `permissions` and `org`; each defaults to its own name. A list claim is an array of strings or one whitespace-separated string. A missing claim leaves the member empty or `null`. |

The principal's `subject` is the asserted subject, `claims` is every forwarded claim, `via` is the resource's name; `amr`, `acr`, `sessionId` and `authenticatedAt` are empty or `null`.

An empty subject, or a claim of the wrong type, is a refusal (`{ refused: true, reason, challenge: null }`); the verifier never throws.
