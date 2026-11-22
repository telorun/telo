# Presentations

A presentation says **what the credential material is**, never where the request carried it. An API key sent as `Bearer`, a session identifier and a JWT held in a cookie are all a `token`, so a verifier can be fed from any location that suits it. The variants are told apart by `type`:

| `type` | Members | Used for |
| --- | --- | --- |
| `token` | `token`, optional `scheme` | JWTs, API keys, session identifiers, introspected tokens |
| `basic` | `username`, `password` | HTTP Basic |
| `certificate` | `subject`, `issuer`, `serialNumber`, `fingerprint256`, `validFrom`, `validTo`, `subjectAltNames`, `pem`, `verified`, `via` (`listener` \| `proxy`) | A TLS client certificate, with the fields a server exposes as its request's client certificate |
| `asserted` | `subject`, `claims` | An identity a trusted reverse proxy vouches for |
| `signature` | `base`, `signatures`, optional `keyId`, `algorithm`, `created`, `expires` | A signature over bytes the transport assembled: HMAC-signed webhooks, HTTP message signatures |

Every secret member (and every member of `certificate` and `asserted` that identifies the caller, and the `base` and `signatures` of `signature`) carries `x-telo-sensitive: true`, so it is `[redacted]` in trace payloads and the debug wire. A new verifier keeps that by taking its presentation from these shapes.

## Narrowing

`Auth.Presentation` is the union of the five. A concrete verifier declares in its own `inputType` the variants it can read, with a `presentation` property of the variant's shape (`!ref Auth.TokenPresentation`, or an `anyOf` of several). A transport checks a credential source's output against that member, so a source producing a presentation the verifier cannot read is refused by `telo check` before anything runs. `Auth.TrustedHeader` narrows to `Auth.AssertedPresentation`; calling it with a token is `CONTRACT_INPUTS_MISMATCH`.

## Signatures

A `signature` presentation carries **the signed bytes, not the request**: `base` is exactly what the sender signed, assembled by the transport (for an HTTP message signature, the RFC 9421 signature base; for a webhook, the provider's concatenation of timestamp and body), so a verifier stays transport-neutral and never sees a request. `signatures` is a list because a provider sends several while a secret rotates. `keyId` and `algorithm` are what the request *claims*; a verifier treats `algorithm` as a claim to check against the key's own algorithm, never as a choice. `created` and `expires`, when the request states them, are what a verifier's freshness settings judge. The four optional members are nullable; a transport that does not know one leaves it `null` or omits it.

`AuthSignature.Verifier` takes these presentations only. Feeding it a token source, or feeding a signature source to `AuthBearer.Jwt`, is `CONTRACT_INPUTS_MISMATCH`.
