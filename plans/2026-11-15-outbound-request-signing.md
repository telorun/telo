---
status: draft
priority: medium
depends-on: [2026-11-06-auth-building-blocks.md]
packages: [modules/http-client, modules/http-signature, apps/authoring-agent, docs]
refinement: not-started
---

# Outbound request signing: signed webhooks and RFC 9421 requests

## Problem

`Http.Credential` never sees the body of the request it authenticates, so an application cannot sign the webhooks it sends (an HMAC over the body, Standard Webhooks style) or sign a request under RFC 9421 with a `Content-Digest`. The receiving half — `Http.FromBodySignature`, `Http.FromMessageSignature`, `AuthSignature.Verifier` and the shared grammar module `http-signature` — exists, so an application can verify what a partner signs but cannot sign what it sends back.

## Constraints

None.

## Surface

**Added**
- `Http.MessageSignature` — RFC 9421 outbound credential: `keyId`, `algorithm`, `secret` / `jwk`, `components`, `label` (default `sig1`), `expiresIn`.
- `Http.BodySignature` — webhook outbound credential: `algorithm`, `secret` / `jwk`, `base`, `signature: { header, value?, encoding }` (`value` an `!interpolate` over the binding `signature`), `timestamp: { header, unit }`.
- reading member `readsBody` on an `Http.Credential` — the credential signs the body.
- `ERR_HTTP_CREDENTIAL_BODY_STREAMED` — a streamed body sent through a body-reading credential.

**Changed**
- `Http.Credential` input — gains `request.body` (`Telo.Bytes`, nullable, `x-telo-sensitive`).
- `Http.Credential` dispatch — every credential runs once per attempt on the frozen request, and its headers replace same-named ones.
- `http-signature`'s code exports — gain the `Signature-Input` / `Signature` structured-field writer.

**Removed**
- None.

## Solution

**The credential contract (`http-client`).**
- The input of `Http.Credential` gains `request.body` (`Telo.Bytes`, nullable, `x-telo-sensitive`). The client fills it only for a credential whose reading publishes `readsBody: true`.
- **A credential runs last, on the final request, once per attempt.** The client freezes the request — the absolute URL, the serialized body and every header but the ones the credential writes — and hands it over; the credential's headers then replace any of the same name. A retry or the 401 retry signs again, so a signature never outlives its attempt.
- A streamed body sent through a `readsBody` credential is refused at the call with `ERR_HTTP_CREDENTIAL_BODY_STREAMED`, since the signature needs every byte before the first is sent.
- Existing credentials publish nothing new and are unchanged.

What a credential receives, before and after:

```json
{ "request": { "method": "POST", "url": "https://hooks.acme.test/events", "headers": { "content-type": "application/json", "webhook-id": "evt_1" } } }
```

```json
{ "request": { "method": "POST", "url": "https://hooks.acme.test/events", "headers": { "content-type": "application/json", "webhook-id": "evt_1" }, "body": "eyJ0eXBlIjoib3JkZXIuY3JlYXRlZCJ9" } }
```

**Two credential kinds** sit beside `Http.BearerToken` and the others. Their key is `AuthSignature.Verifier`'s key shape — `algorithm: hmac-sha256` with `secret`, `algorithm: ed25519` with `jwk` — except that an `ed25519` `jwk` is the private key (`d` required):
- `Http.MessageSignature { keyId?, algorithm, secret | jwk, components, label, expiresIn? }` writes `Content-Digest` when `content-digest` is covered (the digest of the empty body when there is none), then `Signature-Input` and `Signature`. `components` takes the entries `Http.FromMessageSignature` accepts. `label` defaults to `sig1`, and `created` is always stated. It publishes `readsBody: true` when `components` names `content-digest`.
- `Http.BodySignature { algorithm, secret | jwk, base, signature, timestamp? }` mirrors `Http.FromBodySignature` and always publishes `readsBody: true`.
  - `base` is a list of `HttpSignature.BasePart`s holding a `{ type: body }` part, as on the inbound source.
  - `signature: { header, value?, encoding }` names the header written and how the signature is spelled; `value` is an `!interpolate` over the binding `signature` (`v1,${{ signature }}`), omitted meaning the signature alone.
  - `timestamp: { header, unit }`, when given, is written to `header` before `base` is evaluated, so a `{ type: header }` part reads it, as it reads headers the caller already set, such as `webhook-id`.
  - A sender whose one header carries both timestamp and signature (Stripe's own format) is not supported.

**Dependencies:** `http-client` → `http-signature`, the same grammar `http-server` reads with, so what a credential signs cannot drift from what the matching source reads. `http-signature` gains the structured-field writer; `http-client` holds no signature-base or structured-field implementation of its own.

## Examples

**Signing an RFC 9421 request and a Standard Webhooks delivery.** The first request is accepted by a receiver with `Http.FromMessageSignature` over `["@method", "@target-uri", content-digest]` and the matching public key. The timestamp header is written before `base` is evaluated, and the caller sets `webhook-id` itself:

```yaml
kind: Telo.Application
metadata: { name: Sender }
imports:
  Http: ../../modules/http-client
targets: [!ref deliver]
secrets:
  signingJwk:
    env: SIGNING_JWK
    type: object
    required: [kty, crv, x, d]
    additionalProperties: false
    properties:
      kty: { const: OKP }
      crv: { const: Ed25519 }
      x: { type: string }
      d: { type: string }
  hookSecret: { env: HOOK_SECRET, type: string }
---
kind: Telo.Sequence
metadata: { name: deliver }
steps:
  - name: order
    invoke:
      kind: Http.Request
      client:
        kind: Http.Client
        baseUrl: https://partner.acme.test
        credential:
          kind: Http.MessageSignature
          keyId: partner
          algorithm: ed25519
          jwk: !cel "secrets.signingJwk"
          components: ["@method", "@target-uri", content-digest]
          label: sig1
          expiresIn: "5m"
      url: /partner/orders
      method: POST
      body: { orderId: o_1 }
  - name: event
    invoke:
      kind: Http.Request
      client:
        kind: Http.Client
        baseUrl: https://hooks.acme.test
        credential:
          kind: Http.BodySignature
          algorithm: hmac-sha256
          secret: !cel "bytesFromBase64(secrets.hookSecret.substring(6))"
          timestamp: { header: webhook-timestamp, unit: seconds }
          base:
            - { type: header, header: webhook-id }
            - { type: literal, value: . }
            - { type: header, header: webhook-timestamp }
            - { type: literal, value: . }
            - { type: body }
          signature: { header: webhook-signature, value: !interpolate "v1,${{ signature }}", encoding: base64 }
      url: /events
      method: POST
      headers: { webhook-id: evt_1 }
      body: { type: order.created }
```

The two requests it sends:

```
POST /partner/orders HTTP/1.1
Host: partner.acme.test
Content-Type: application/json
Content-Digest: sha-256=:Pz8LBMtt3gVgPUhb2IJAEsy3n2QyuP7Tx2v1tC3dUjM=:
Signature-Input: sig1=("@method" "@target-uri" "content-digest");created=1763200800;expires=1763201100;keyid="partner";alg="ed25519"
Signature: sig1=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:

{"orderId":"o_1"}

POST /events HTTP/1.1
Host: hooks.acme.test
Content-Type: application/json
webhook-id: evt_1
webhook-timestamp: 1763200800
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{"type":"order.created"}
```

A literal `jwk` without `d`, or a `base` with no `{ type: body }` part, is a `SCHEMA_VIOLATION` at `telo check`:

```
$ telo check ./sender.yaml
sender.yaml: deliver.steps[0].invoke.client.credential.jwk: [SCHEMA_VIOLATION] must have required property 'd'
sender.yaml: deliver.steps[1].invoke.client.credential.base: [SCHEMA_VIOLATION] must contain a { type: body } part
```

**A streamed body is refused at the call**, since a body signature needs every byte before the first is sent:

```yaml
kind: Telo.Application
metadata: { name: ExportSender }
imports:
  Http: ../../modules/http-client
  Blob: ../../modules/blob
  BlobFs: ../../modules/blob-fs
targets: [!ref deliver]
variables:
  exportsRoot:
    env: EXPORTS_ROOT
    type: string
    x-telo-type: { name: Telo.HostPath, entry: directory }
    default: exports
secrets: { hookSecret: { env: HOOK_SECRET, type: string } }
---
kind: Telo.Sequence
metadata: { name: deliver }
steps:
  - name: read
    invoke:
      kind: Blob.Get
      store: { kind: BlobFs.Store, root: !cel "variables.exportsRoot" }
    inputs: { key: daily.json }
  - name: send
    invoke:
      kind: Http.Request
      client:
        kind: Http.Client
        baseUrl: https://hooks.acme.test
        credential:
          kind: Http.BodySignature
          algorithm: hmac-sha256
          secret: !cel "secrets.hookSecret"
          base: [{ type: body }]
          signature: { header: x-signature, encoding: hex }
      url: /exports
      method: POST
      body: !cel "steps.read.result.output"
```

```
$ telo run ./export-sender.yaml
Error: [ERR_HTTP_CREDENTIAL_BODY_STREAMED] deliver.steps.send: Http.BodySignature reads the body it signs, and the request body is a stream; send a buffered body
```

## Bookkeeping

- **Docs:** `http-client` credential docs (the two kinds, `readsBody`, that a credential runs once per attempt on the frozen request and its headers win, the streamed-body refusal); `auth-signature`'s Standard Webhooks recipe gains its sending half; `http-signature`'s docs list the writer.
- **Primer and guides:** the primer (`apps/authoring-agent/chat/primer.md`) and `modules/CLAUDE.md`'s outbound-authentication paragraph describe body-signing credentials.
- **Ledger entry** in `docs/guides/what-you-get.md`, under Standard library, auth: signing outbound webhooks and HTTP message signatures, beside the verifying entry.
- **Release:** one `Added` fragment for `http-client` and one for `http-signature`.
- **Floors:** the new vocabulary is added to `http-client`'s own kinds, so it needs no floor for exposing it; `telo release floor` measures any manifest writing it.

## Verify

- A request signed by `Http.MessageSignature` verifies through `Http.FromMessageSignature` and `AuthSignature.Verifier` with the matching public key, with a body and without one; changing one body byte after signing fails as `signature`.
- A webhook signed by `Http.BodySignature` verifies through the Standard Webhooks recipe of `Http.FromBodySignature`, and a GitHub-style one (`base: [{ type: body }]`, no `timestamp`) through the GitHub recipe.
- A retried signed request carries a fresh `created` and timestamp; a 401 retry signs again.
- A per-call header named like a header the credential writes does not reach the wire.
- A streamed body sent through either credential is `ERR_HTTP_CREDENTIAL_BODY_STREAMED`; the same body buffered is signed and sent.
- An existing credential (`Http.BearerToken`) receives no `body`.
- No trace span or inspect payload of a signed request holds its body.
- `http-client` contains no signature-base or structured-field implementation; it resolves `http-signature`.
