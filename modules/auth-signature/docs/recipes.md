# Vendor recipes

A vendor scheme is configuration of two generic pieces, never a kind of its own: `Http.FromBodySignature` assembles the signed bytes from the request, and `AuthSignature.Verifier` checks them. Each recipe below gives the mount's `authentication:` entry and the key the handler dedupes on with `Idempotency.Once`. Providers redeliver, so every recipe pairs the two; the verifier itself never refuses a repeat.

All recipes share one handler shape. The key is the vendor's event id — a header for GitHub, Shopify and Standard Webhooks, a field of the parsed body for Stripe and Slack:

```yaml
kind: Http.Api
metadata: { name: webhooks }
routes:
  - request: { path: /events, method: POST }
    maxBodyBytes: 65536
    handler:
      kind: Idempotency.Once
      store: { kind: KvStore.Store }
      claimTtl: "30s"
      ttl: "24h"
      invoke: { kind: Telo.Value, value: { handled: true } }
    inputs:
      key: !cel "request.body.id"   # the recipe's key
      inputs: {}
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
```

The signature is checked before the body is parsed, so the handler only ever sees a delivery whose bytes were verified. Mount the route as in each recipe, under `authentication.verifiers`. Behind a TLS-terminating proxy, none of these needs `trustProxy`; only RFC 9421's `@target-uri` does.

## Stripe

Header `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>…]`, signed over `<t>.<body>`. Several `v1` entries appear while a secret rotates, and all are presented. Key: `request.body.id` (the event id).

```yaml
authentication:
  verifiers:
    - verifier:
        kind: AuthSignature.Verifier
        maxSignatureAge: 5m
        keys:
          - { subject: stripe, algorithm: hmac-sha256, secret: !cel "secrets.stripeWebhookSecret" }
      from:
        kind: Http.FromBodySignature
        scheme: Stripe
        signature: { header: Stripe-Signature, pattern: "(?:^|,)v1=([0-9a-f]+)", encoding: hex }
        timestamp: { header: Stripe-Signature, pattern: "(?:^|,)t=(\\d+)", unit: seconds }
        base:
          - { type: header, header: Stripe-Signature, pattern: "(?:^|,)t=(\\d+)" }
          - { type: literal, value: . }
          - { type: body }
```

The secret is the endpoint's signing secret (`whsec_…`) used as text.

## GitHub

Header `X-Hub-Signature-256: sha256=<hex>`, signed over the body. GitHub signs no timestamp, so the recipe writes no `timestamp:` and no `maxSignatureAge`: writing one would refuse every delivery as `stale`. Key: the `X-GitHub-Delivery` header.

```yaml
authentication:
  verifiers:
    - verifier:
        kind: AuthSignature.Verifier
        keys:
          - { subject: github, algorithm: hmac-sha256, secret: !cel "secrets.githubWebhookSecret" }
      from:
        kind: Http.FromBodySignature
        scheme: Signature
        signature: { header: X-Hub-Signature-256, pattern: "sha256=([0-9a-f]+)", encoding: hex }
        base: [{ type: body }]
```

Key: `!cel "request.headers['x-github-delivery']"`.

## Slack

Headers `X-Slack-Signature: v0=<hex>` and `X-Slack-Request-Timestamp: <seconds>`, signed over `v0:<timestamp>:<body>`. Key: the `event_id` of the parsed body (`request.body.event_id`).

```yaml
authentication:
  verifiers:
    - verifier:
        kind: AuthSignature.Verifier
        maxSignatureAge: 5m
        keys:
          - { subject: slack, algorithm: hmac-sha256, secret: !cel "secrets.slackSigningSecret" }
      from:
        kind: Http.FromBodySignature
        scheme: Signature
        signature: { header: X-Slack-Signature, pattern: "v0=([0-9a-f]+)", encoding: hex }
        timestamp: { header: X-Slack-Request-Timestamp, unit: seconds }
        base:
          - { type: literal, value: "v0:" }
          - { type: header, header: X-Slack-Request-Timestamp }
          - { type: literal, value: ":" }
          - { type: body }
```

## Shopify

Header `X-Shopify-Hmac-Sha256: <base64>`, signed over the body, with no timestamp (no `timestamp:`, no `maxSignatureAge`). Key: the `X-Shopify-Event-Id` header.

```yaml
authentication:
  verifiers:
    - verifier:
        kind: AuthSignature.Verifier
        keys:
          - { subject: shopify, algorithm: hmac-sha256, secret: !cel "secrets.shopifyApiSecret" }
      from:
        kind: Http.FromBodySignature
        scheme: Signature
        signature: { header: X-Shopify-Hmac-Sha256, encoding: base64 }
        base: [{ type: body }]
```

Key: `!cel "request.headers['x-shopify-event-id']"`.

## Standard Webhooks

Headers `webhook-id`, `webhook-timestamp` (seconds) and `webhook-signature: v1,<base64> [v1,<base64>…]`, signed over `<id>.<timestamp>.<body>`. The secret is `whsec_` followed by base64 key bytes, so it is decoded: `bytesFromBase64(…)` over the part after the prefix. Key: the `webhook-id` header.

```yaml
authentication:
  verifiers:
    - verifier:
        kind: AuthSignature.Verifier
        maxSignatureAge: 5m
        keys:
          - subject: standard-webhooks
            algorithm: hmac-sha256
            secret: !cel "bytesFromBase64(secrets.webhookSecret.substring(6))"
      from:
        kind: Http.FromBodySignature
        scheme: Signature
        signature: { header: webhook-signature, pattern: "(?:^|\\s)v1,([A-Za-z0-9+/=]+)", encoding: base64 }
        timestamp: { header: webhook-timestamp, unit: seconds }
        base:
          - { type: header, header: webhook-id }
          - { type: literal, value: . }
          - { type: header, header: webhook-timestamp }
          - { type: literal, value: . }
          - { type: body }
```

Key: `!cel "request.headers['webhook-id']"`.

## Choosing `maxSignatureAge`

Five minutes is what Stripe, Slack and Standard Webhooks recommend: long enough for clock skew and a slow network, short enough that a captured delivery stops working. It bounds replay, it does not remove it; the idempotency key is what makes a redelivery harmless.
