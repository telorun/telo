# AuthSignature

Verifies signed requests: webhook deliveries (Stripe, GitHub, Slack, Shopify, Standard Webhooks) and HTTP message signatures (RFC 9421). It checks a signature over the signed bytes against keys you configure and answers with the sending service, or a refusal. It is transport-neutral: a credential source in the transport builds the signed bytes, and the verifier never sees a request.

| Kind | What it is |
| --- | --- |
| `AuthSignature.Verifier` | An `Auth.Verifier` taking `signature` presentations only. `keys`, `maxSignatureAge`, `clockTolerance`. See [verifier](./docs/verifier.md). |

```yaml
imports:
  AuthSignature: oci://ghcr.io/telorun/auth-signature@<version>
---
kind: AuthSignature.Verifier
metadata: { name: stripe }
maxSignatureAge: 5m
keys:
  - { subject: stripe, algorithm: hmac-sha256, secret: !cel "secrets.stripeWebhookSecret" }
```

A key is `{ id?, subject, algorithm, … }` and states its own algorithm, so a request never chooses one: `hmac-sha256` takes a `secret`, `ed25519` a public `jwk`. An accepted signature is a principal of kind `service` whose subject is the matching key's. A refusal is `unknownKey`, `algorithm`, `signature`, `stale` or `expired`, each with no challenge.

Replay is the receiver's job, not the verifier's: providers redeliver a signed delivery when your endpoint answers a 5xx, so a verifier that refused repeats would lose the event. Dedupe on the provider's delivery id with `Idempotency.Once`. The [vendor recipes](./docs/recipes.md) pair the two.

Docs: [verifier](./docs/verifier.md) · [vendor recipes](./docs/recipes.md)
