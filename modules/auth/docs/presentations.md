# Presentations

A presentation says **what the credential material is**, never where the request carried it. An API key sent as `Bearer`, a session identifier and a JWT held in a cookie are all a `token`, so a verifier can be fed from any location that suits it. The variants are told apart by `type`:

| `type` | Members | Used for |
| --- | --- | --- |
| `token` | `token`, optional `scheme` | JWTs, API keys, session identifiers, introspected tokens |
| `basic` | `username`, `password` | HTTP Basic |
| `certificate` | `subject`, `issuer`, `serialNumber`, `fingerprint256`, `validFrom`, `validTo`, `subjectAltNames`, `pem`, `verified`, `via` (`listener` \| `proxy`) | A TLS client certificate, with the fields a server exposes as its request's client certificate |
| `asserted` | `subject`, `claims` | An identity a trusted reverse proxy vouches for |

Every secret member (and every member of `certificate` and `asserted` that identifies the caller) carries `x-telo-sensitive: true`, so it is `[redacted]` in trace payloads and the debug wire. A new verifier keeps that by taking its presentation from these shapes.

## Narrowing

`Auth.Presentation` is the union of the four. A concrete verifier declares in its own `inputType` the variants it can read, with a `presentation` property of the variant's shape (`!ref Auth.TokenPresentation`, or an `anyOf` of several). A transport checks a credential source's output against that member, so a source producing a presentation the verifier cannot read is refused by `telo check` before anything runs. `Auth.TrustedHeader` narrows to `Auth.AssertedPresentation`; calling it with a token is `CONTRACT_INPUTS_MISMATCH`.
