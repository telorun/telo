# The verifier

`AuthSignature.Verifier` extends `Auth.Verifier` and reads `signature` presentations only (see `Auth` [presentations](https://hub.telo.run/module/oci/ghcr.io/telorun/auth/)): the exact bytes that were signed (`base`), the signatures presented (`signatures`), and what the request claimed about them (`keyId`, `algorithm`, `created`, `expires`). Feeding it a credential source that yields a token presentation is `CONTRACT_INPUTS_MISMATCH`, and so is feeding a signature source to `AuthBearer.Jwt`.

## Keys

`keys` is a list of `{ id?, subject, algorithm, … }`.

| `algorithm` | Key member | Notes |
| --- | --- | --- |
| `hmac-sha256` | `secret` | A string, used as its UTF-8 bytes, or raw bytes. A base64 secret is `!cel "bytesFromBase64(…)"`. |
| `ed25519` | `jwk` | A public OKP / Ed25519 JWK: `kty: OKP`, `crv: Ed25519`, `x` (43 base64url characters) and an optional `kid`. A private key (`d`) or another curve is refused by `telo check`. A secret holding one is declared `type: object`, which the kernel decodes from its JSON environment text. |

Another algorithm is added later as one more value.

**Selecting a key.** A presentation with a `keyId` is checked against the keys with that `id`. One without is tried against every key that has no `id`, each under its own algorithm, so a secret rotation is two id-less keys: either matching accepts. The presentation's `algorithm` (RFC 9421 `alg`) is a claim checked against the key's algorithm and never a way to choose one; a claim that is not the key's algorithm is refused `algorithm`. A request presenting several signatures (Stripe sends one per active secret) is accepted when any one verifies. Every candidate key and signature is checked and every comparison is constant-time, so timing does not say which one matched.

## Freshness

`maxSignatureAge` has no default. Written, a presentation with no `created`, one older than the age, or one dated further in the future than `clockTolerance`, is refused `stale`, whichever source fed it. Omitted, no age is judged, which is what GitHub and Shopify need: they sign no timestamp. `clockTolerance` (default `30s`) is the leeway for `created` and `expires` against this host's clock. A passed `expires` is always refused `expired`, with or without `maxSignatureAge`.

Freshness is judged after the signature verifies, and only as far as the source supplied `created` and `expires` inside the signed bytes. A source that reads a timestamp from a header the signature does not cover gives an attacker a way to refresh an old delivery, so a recipe's `base` must contain the timestamp wherever the provider signs it.

## Answers

An accepted signature answers `{ principal }` with `kind: service` and the matching key's `subject`; every other principal member is empty or null, and `via` is the verifier's name. A refusal answers `{ refused: true, reason, challenge: null }`:

| `reason` | Meaning |
| --- | --- |
| `unknownKey` | No key matches the presentation's `keyId`, or it names none and no key lacks an `id`. |
| `algorithm` | The presentation claims an algorithm that is not the algorithm of any candidate key. |
| `signature` | No presented signature verifies under any candidate key. |
| `stale` | `maxSignatureAge` is written and `created` is absent, too old or too far ahead. |
| `expired` | `expires` has passed, beyond `clockTolerance`. |

The challenge is null: the transport answers a refusal with the `WWW-Authenticate` of the credential source's `scheme`. The verifier publishes `challenges: []` and no `issuer`.

## Replay

A signature stays valid until it ages out, and a provider redelivers the same signed delivery on purpose. Making the verifier refuse repeats would drop real redeliveries, so the receiver dedupes with `Idempotency.Once` keyed on the provider's delivery id. The [recipes](./recipes.md) show the key for each vendor.
