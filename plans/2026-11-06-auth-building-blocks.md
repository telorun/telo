---
status: draft
priority: medium
depends-on: []
packages: [modules/one-time, modules/auth, modules/auth-signature, modules/http-signature, modules/http-server, modules/http-client, modules/protection, examples/order-webhook, apps/authoring-agent, apps/hub, docs]
---

# Auth building blocks: single-use tokens, signed requests, sign-in throttling

## Problem

Three things every application with sign-in or webhooks needs are missing, and the identity roadmap had them inside domain modules.

- **Single-use tokens.** A password-reset link, an email-verification link, a magic link, an invitation or a typed one-time code is a secret that works once, expires and is tied to whoever it was issued for. Nothing in the standard library issues one. `oauth-client` keeps its own one-off record for a pending sign-in. Everyone else hand-builds the same thing over `KvStore.Store` and a `Crypto.Random`, usually without atomic redemption or attempt limits.
- **Signed requests.** Webhook providers sign each delivery with an HMAC over the body (Stripe, GitHub, Slack, Shopify, Standard Webhooks), and RFC 9421 signs HTTP messages in general. A mount's `authentication:` runs before the body is read, and no credential source or verifier understands signatures. So `queue`'s "receiving webhooks" guide says "verify the signature first" without being able to show how, and `examples/order-webhook` falls back to a shared bearer token. Outbound, `Http.Credential` never sees the body, so an application cannot sign the webhooks it sends.
- **Sign-in throttling per client.** `Protection.PasswordThrottle` limits guessing of one account. Its docs leave limiting per client address to "the server's rate limit on the route", which does not exist. Nothing stops one address from trying API keys, session ids or passwords against many accounts.

## Solution

### 1. `one-time` — single-use tokens (new module, `metadata.name: OneTime`)

**Token sets.** A set is a `Telo.Provider` with its own durable `name`, a `store` (`KvStore.Store`), a required `ttl` (`Telo.Duration`) and an optional `dataType` (a `Telo.JsonSchema`, `x-telo-serializable`) for what each token carries. It comes in two kinds under the abstract `OneTime.Tokens`:
- `OneTime.Links` — a random secret sent in a URL. `bytes` defaults to 32 and is at least 16. The token is base64url.
- `OneTime.Codes` — a short code a person types. `digits` defaults to 6 (6–10). `maxAttempts` defaults to 5.

**Operations.** Each names its set through a reference slot, so pairing an operation with the wrong kind of set is `REFERENCE_KIND_MISMATCH` before the app runs.
- `OneTime.Issue` (either kind): `{ subject, data?, holder? }` → `{ token, expiresAt }`.
  - `subject` names who or what the token is for: an email, a user id, an invitation.
  - **A set holds at most one live token per subject.** Issuing again replaces the previous token, so "resend the code" invalidates the old one.
  - `data` is held to the set's `dataType`.
  - `holder` is a value the redeemer must present again, such as an identifier set in the browser that asked.
  - `token` is sensitive.
- `OneTime.RedeemLink` (on `Links`): `{ token, holder? }`.
- `OneTime.RedeemCode` (on `Codes`): `{ subject, code, holder? }`.
- `OneTime.Revoke`: `{ subject }` → `{ revoked }`.

**What a redemption answers.** Success is `{ redeemed: true, subject, data }`, with `data` typed from the set's `dataType`. Otherwise it is `{ redeemed: false, reason }`, where `reason` is one of:
- `unknown` — never issued, already used, replaced, revoked or expired; these are not told apart;
- `holderMismatch` — the token is **not** consumed, so it can still be opened by the right holder;
- `mismatch` — a wrong code, which uses up one attempt;
- `exhausted` — the attempt that used up the last one; the code is then deleted.

A refused redemption is an outcome the page renders, never a throw.

**Storage.** One record per subject is the live token, and an index points at it.
- `<name>/t/<sha256(subject)>` holds the `subject` (a link redemption answers it), the digest of the token (for a code, digested together with the subject), `data`, the digest of `holder`, `expiresAt` and, for a code, the attempts left. A dump of the store yields no usable link or code. Six digits can be guessed offline from a dump while the code lives, which is why a code set's `ttl` should be minutes.
- A link adds a lookup `<name>/l/<sha256(token)>` → the subject digest. The lookup grants nothing: a token is live only while the subject record holds its digest.
- **Issue** writes the new lookup, then the subject record (which replaces the previous token in one write), then deletes the old lookup. A crash leaves at most a lookup that reads as `unknown`, never two redeemable links.
- **Redeeming a link** reads the lookup and the subject record, compares digest, expiry and holder, then makes one `compareAndDelete` on the subject record, so a token works exactly once across every replica sharing the store. A wrong code is one `compareAndSet` on the subject record. A write that keeps losing the race is `ERR_ONE_TIME_CONTENDED`.
- A store that throws is `ERR_ONE_TIME_STORE_UNAVAILABLE`, with the thrown value as `cause`; a cancellation passes through. This is the same guard `session` has.
- Two sets claiming one `name` on one store are `ONE_TIME_NAME_DUPLICATE`, a resource rule with `coReferrers: /store` spanning both kinds, twinned by `ERR_ONE_TIME_NAME_DUPLICATE`.

**Dependencies:** `one-time` → `kv-store`. It imports no transport and no identity module. Rate-limiting how often tokens are issued is the route's job (`RateLimit.Guard`); a code's attempts restart on every reissue, so the issue route's limit is what bounds guessing across reissues, and the docs say so.

### 2. Signed requests

**The presentation (`auth`).** `Auth.Presentation` gains a fifth variant, `Auth.SignaturePresentation`. Its `type` is `signature`, and it has these members:
- `base` — the exact bytes that were signed (`Telo.Bytes`);
- `signatures` — the signatures presented, as a list of bytes, since Stripe sends several during a secret rotation;
- `keyId`, `algorithm` — each nullable;
- `created`, `expires` — nullable `Telo.Timestamp`s.

`base` and `signatures` are `x-telo-sensitive`. The transport builds `base`, so the verifier never sees a request.

**One shared home for the grammar (`http-signature`, new module, `metadata.name: HttpSignature`, MIT, imports nothing).** It exposes through `exports.code` the RFC 9421 signature-base builder, the `Signature-Input` / `Signature` structured-field reader and writer (RFC 9651), `Content-Digest` (RFC 9530) and the evaluator of body-signature `base` parts. `http-server` and `http-client` both import it, so a request signed by an outbound credential cannot drift from what the matching inbound source reads. It imports no transport and no verifier.

**Reading the body before authentication (`http-server`).**
- A credential source may publish `coversBody: true` in its reading. On a mount or route whose `authentication:` lists such a source, the server reads the body (up to `maxBodyBytes`) before running the verifiers, after the throttle check (part 3).
- **The buffered body is handed on through the server's own body pipeline.** Whatever is mounted — a parsed route, a streamed-body route, `Mcp.HttpEndpoint` — receives exactly the verified bytes. A `Telo.Mount` reads the request body only through what the server hands it, never from the raw socket.
- The body is bounded by the matched route's `maxBodyBytes`, else the server's (default 1 MiB), and a longer one is refused with the existing 413 before any verifier runs. A mount entry gains no key of its own. The docs say a webhook route or server should set a small bound, since an unauthenticated caller can make the server buffer up to it; with a throttle the reservation comes first, so in-flight buffers per key are capped at `limit` × the bound.
- The credential-source input gains optional members — the buffered body, the exact target URI and the raw query — so sources that do not read them are unaffected.

**Two credential sources (`http-server`, under `Http.CredentialSource`).** Both are generic. Vendor schemes are documented recipes, not kinds. Both take `scheme` (an `Http.AuthScheme`, as `Http.FromHeader` does), which is what the 401's `WWW-Authenticate` carries when a signature is refused.
- `Http.FromMessageSignature { label?, components, scheme }` reads RFC 9421 `Signature-Input` / `Signature`.
  - **Which signature it reads:** the one named `label`. Without a label, the request must carry exactly one signature, otherwise it is malformed.
  - **Required coverage:** the signature must cover every entry of `components`. These are derived components (`@method`, `@target-uri`, `@authority`, `@scheme`, `@request-target`, `@path`, `@query`, `@query-param;name=…`) and lower-case header field names; an entry of any other form, or one carrying `;sf`, `;bs`, `;key` or `;req`, is a `SCHEMA_VIOLATION` at `telo check`. A signature covering less is malformed. `components` is exactly what the signature authenticates: a list without `content-digest` leaves the body unauthenticated, which is what a signed `GET` wants.
  - **Base and members:** it builds the signature base of RFC 9421 §2.5, with `@target-uri` as the server already derives it for DPoP. It takes `keyid`, `alg`, `created` and `expires` from the signature parameters; the `nonce` parameter is not read in this plan.
  - **Body:** when `content-digest` is covered, it checks `Content-Digest` (RFC 9530, `sha-256` / `sha-512`) against the body (an absent body is the empty one), and a mismatch is refused 401. A signature using a component parameter the source does not support is malformed.
  - It publishes `coversBody: true` only when `components` names `content-digest`.
- `Http.FromBodySignature { signature, timestamp?, base, scheme }` reads the webhook family.
  - `signature: { header, pattern?, encoding }` — `pattern` is an RE2 pattern (`format: re2-pattern`, checked by `telo check`) whose first group captures each signature, all matches taken. Without one, the whole header is the signature. `encoding` is `hex | base64 | base64url`.
  - `timestamp: { header, pattern?, unit: seconds | milliseconds }`, optional. A source that declares it treats a missing or unreadable timestamp as malformed; a source that does not (GitHub, Shopify) yields a presentation with no `created`.
  - `base`, an ordered list of parts joined with nothing between them: `{ text }`, `{ header, pattern? }`, or `{ body: true }`.
  - It always publishes `coversBody: true`.

A missing signature header is "no credential" for both sources. A present but unreadable one throws `ERR_HTTP_CREDENTIAL_MALFORMED`. Feeding either source to a verifier that cannot take a signature presentation is the existing `CONTRACT_INPUTS_MISMATCH`.

**The verifier — `auth-signature` (new module, `metadata.name: AuthSignature`).** `AuthSignature.Verifier` extends `Auth.Verifier` and takes `signature` presentations only.
- **`keys`** is a list of `{ id?, subject, algorithm, … }` where each key states its own `algorithm`, so no algorithm is ever chosen by the request:
  - `algorithm: hmac-sha256` takes `secret`, a sensitive string (used as its UTF-8 bytes) or `Telo.Bytes`; a base64 secret is `!cel "bytesFromBase64(…)"`;
  - `algorithm: ed25519` takes `jwk`, a JWK object of a closed OKP / Ed25519 shape written in the kind's own schema (a public key here: `kty`, `crv`, `x`, optional `kid`; a `d` is refused). A secret holding one is declared `type: object`, which the kernel decodes from its JSON env text.
  - A presentation with a `keyId` is checked against the key with that `id`. One without a `keyId` is tried against each key that has no `id`, each under its own algorithm, which covers secret rotation.
  - The presentation's `algorithm` (RFC 9421 `alg`) is a claim checked against the key's algorithm, never a selector.
- **Supported algorithms** are `hmac-sha256` and `ed25519`, the two both directions are verified for. Another is added later as one more enum value.
- **Freshness** applies whenever the presentation carries `created`, which only a source that reads a timestamp (or an RFC 9421 signature stating `created`) provides: `maxSignatureAge` defaults to 5 minutes, `clockTolerance` to 30 seconds, and a passed `expires` is refused. Requiring a timestamp is configuring it on the source; the verifier has no switch for it.
- **Principal:** an accepted signature yields `kind: service` with `subject` from the matching key.
- **Refusals** are `unknownKey`, `algorithm`, `signature`, `stale` and `expired`. Each comes with a null challenge, and the verifier publishes `challenges: []` and no `issuer`.
- **Comparisons:** every comparison is constant-time.
- **Replay is the receiver's idempotency, not the verifier's.** Providers redeliver the same signed delivery on a 5xx, so a verifier that refused a repeat would lose the event. A handler dedupes on the provider's delivery id with `Idempotency.Once`; each vendor recipe pairs the two.

**Dependencies:** `auth-signature` → `auth`. It imports no transport. `http-server` → `http-signature`; `http-client` → `http-signature`.

**Outbound twin (`http-client`).**
- The input of `Http.Credential` gains `request.body` (`Telo.Bytes`, nullable). The client fills it only for a credential whose reading publishes `coversBody: true`, and freezes the request first: the credential sees the final serialized body and the final headers, and what it signs is what is sent.
- A streamed body sent through such a credential is refused at the call with `ERR_HTTP_CREDENTIAL_BODY_STREAMED`.
- Existing credentials publish nothing new and are unchanged.
- Two new credential kinds sit beside `Http.BearerToken` and the others. Their key is the verifier's key shape, with a private `jwk` (`d` required) for `ed25519`:
  - `Http.MessageSignature { keyId?, algorithm, secret | jwk, components, label, expiresIn? }` writes `Content-Digest` when `content-digest` is covered (the digest of the empty body when there is none), then `Signature-Input` and `Signature`. `label` defaults to `sig1`, and `created` is always stated.
  - `Http.BodySignature { algorithm, secret | jwk, base, signature, timestamp? }` mirrors the inbound source. `signature: { header, value?, encoding }` names the header written and how the signature is spelled; `value` is an `!interpolate` over the binding `signature` (`v1,${{ signature }}`), omitted meaning the signature alone. `timestamp: { header, unit }`, when given, is written to `header` before `base` is evaluated, so a `{ header }` part reads it, as it reads headers the caller already set, such as `webhook-id`. A sender whose one header carries both timestamp and signature (Stripe's own format) is not supported.

### 3. Throttling sign-in per client (`http-server`)

`authentication:` gains `throttle: { budget, key? }`.
- `budget` (required) is a `RateLimit.Budget`, the kind `Protection.PasswordThrottle.budget` names. Its `limit` and `window` say how many attempts are in flight or refused per window.
- `key` is evaluated per request over `request` and defaults to `request.ip`, the server's client address, which is correct only under a correct `trustProxy`.
- A route's `authentication.throttle` replaces the mount's whole, as every other `authentication` key a route writes does; a route writing only `key` is a `SCHEMA_VIOLATION`. A budget shared by mount and route is a named resource referenced from both, and a budget has no namespace of its own on its store, so a route keeps its own counter by suffixing the key.

**Per request:**
1. **Before anything else** — before the body is read and before any verifier runs — the server reserves 1 under the key.
2. **A spent budget** is answered 429 with `Retry-After` from the budget, code `ERR_HTTP_AUTHENTICATION_THROTTLED`, `data: { retryAfter }`. No verifier runs, so a throttled client costs no password hash and no store read.
3. **After authentication:** an accepted credential, an anonymous request and a verifier that throws settle the reservation to 0. A request carrying no credential is anonymous, under `anonymous: deny` too, and spends nothing: the throttle counts guesses, not requests. A refused or malformed credential leaves it spent.
4. **A budget whose store throws** answers `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` (503) with `data.stage: throttle`; the throttle never fails open.

**Sizing.** The reservation is atomic, so parallel wrong guesses from one address can never exceed `limit`. The price is that `limit` also counts requests still in flight: size it as the peak concurrent requests per key plus the failures allowed. A budget over a process-local `Cache.Store` bounds each replica separately; a fleet-wide bound needs a shared store.

The code is raised into the route, router and server `catches:` lists through `x-telo-catches-for`, beside the four existing refusals, and has a built-in problem body. This throttle covers every verifier on every `Telo.Mount`. `Protection.PasswordThrottle` stays the per-account half, and its docs now point here instead of at a rate limit that did not exist.

**Dependencies:** `http-server` → `rate-limit` (new edge; `rate-limit` imports only `cache`).

## Examples

**Single-use tokens: a bound reset link, a typed code, revoking.** The `Console` steps stand in for a mailer. A real issue route also carries a `RateLimit.Guard`, since a code's attempts restart on every reissue.

```yaml
kind: Telo.Application
metadata: { name: PasswordReset }
imports:
  Http: ../../modules/http-server
  OneTime: ../../modules/one-time
  KvStore: ../../modules/kv-store-memory
  Console: ../../modules/console
targets: [!ref server]
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
---
kind: OneTime.Links
metadata: { name: resetLinks }
name: password-reset
store: { kind: KvStore.Store }
ttl: 30m
dataType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [returnTo]
    additionalProperties: false
    properties: { returnTo: { type: string } }
---
kind: OneTime.Codes
metadata: { name: signInCodes }
name: sign-in-code
store: { kind: KvStore.Store }
ttl: 10m
digits: 6
maxAttempts: 5
---
kind: Http.Api
metadata: { name: resetRoutes }
routes:
  - request:
      path: /resets
      method: POST
      schema:
        headers:
          type: object
          required: [x-browser-id]
          properties: { x-browser-id: { type: string } }
        body:
          type: object
          required: [email, returnTo]
          properties: { email: { type: string }, returnTo: { type: string } }
    handler:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [email, returnTo, browserId]
          properties: { email: { type: string }, returnTo: { type: string }, browserId: { type: string } }
      steps:
        - name: issue
          invoke: { kind: OneTime.Issue, tokens: !ref resetLinks }
          inputs:
            subject: !cel "inputs.email"
            holder: !cel "inputs.browserId"
            data: { returnTo: !cel "inputs.returnTo" }
        - name: send
          invoke: !ref Console.writeLine
          inputs:
            output: !interpolate "reset link for ${{ inputs.email }}: /reset/${{ steps.issue.result.token }}"
      outputs:
        expiresAt: !cel "string(steps.issue.result.expiresAt)"
    inputs:
      email: !cel "request.body.email"
      returnTo: !cel "request.body.returnTo"
      browserId: !cel "request.headers['x-browser-id']"
    returns:
      - status: 202
        content: { application/json: { body: { expiresAt: !cel "result.expiresAt" } } }
  - request:
      path: /resets/redeem
      method: POST
      schema:
        headers:
          type: object
          required: [x-browser-id]
          properties: { x-browser-id: { type: string } }
        body:
          type: object
          required: [token]
          properties: { token: { type: string } }
    handler: { kind: OneTime.RedeemLink, tokens: !ref resetLinks }
    inputs:
      token: !cel "request.body.token"
      holder: !cel "request.headers['x-browser-id']"
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
  - request:
      path: /resets/cancel
      method: POST
      schema:
        body:
          type: object
          required: [email]
          properties: { email: { type: string } }
    handler: { kind: OneTime.Revoke, tokens: !ref resetLinks }
    inputs: { subject: !cel "request.body.email" }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
  - request:
      path: /codes
      method: POST
      schema:
        headers:
          type: object
          required: [x-browser-id]
          properties: { x-browser-id: { type: string } }
        body:
          type: object
          required: [email]
          properties: { email: { type: string } }
    handler:
      kind: Telo.Sequence
      inputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          required: [email, browserId]
          properties: { email: { type: string }, browserId: { type: string } }
      steps:
        - name: issue
          invoke: { kind: OneTime.Issue, tokens: !ref signInCodes }
          inputs: { subject: !cel "inputs.email", holder: !cel "inputs.browserId" }
        - name: send
          invoke: !ref Console.writeLine
          inputs:
            output: !interpolate "sign-in code for ${{ inputs.email }}: ${{ steps.issue.result.token }}"
      outputs:
        expiresAt: !cel "string(steps.issue.result.expiresAt)"
    inputs:
      email: !cel "request.body.email"
      browserId: !cel "request.headers['x-browser-id']"
    returns:
      - status: 202
        content: { application/json: { body: { expiresAt: !cel "result.expiresAt" } } }
  - request:
      path: /codes/redeem
      method: POST
      schema:
        headers:
          type: object
          required: [x-browser-id]
          properties: { x-browser-id: { type: string } }
        body:
          type: object
          required: [email, code]
          properties: { email: { type: string }, code: { type: string } }
    handler: { kind: OneTime.RedeemCode, tokens: !ref signInCodes }
    inputs:
      subject: !cel "request.body.email"
      code: !cel "request.body.code"
      holder: !cel "request.headers['x-browser-id']"
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - { path: /auth, mount: !ref resetRoutes }
```

Redeeming from a browser other than the one that asked answers `{ "redeemed": false, "reason": "holderMismatch" }`, and the same token still redeems from the right one. The fifth wrong guess at a code is `{ "redeemed": false, "reason": "exhausted" }`, after which even the right code is `unknown`. Pointing the code route's handler at `resetLinks` is refused before the app runs:

```
$ telo check ./manifest.yaml
manifest.yaml: routes[4].handler.tokens: [REFERENCE_KIND_MISMATCH] OneTime.RedeemCode needs a OneTime.Codes, got OneTime.Links
```

**Verifying a Stripe webhook, with a throttle.** The budget is a named resource because the mount and a route both use it. Redeliveries are the handler's to dedupe with `Idempotency.Once` keyed on the provider's event id, which `examples/order-webhook` shows after this change.

```yaml
kind: Telo.Application
metadata: { name: StripeReceiver }
imports:
  Http: ../../modules/http-server
  AuthSignature: ../../modules/auth-signature
  RateLimit: ../../modules/rate-limit
  CacheMemory: ../../modules/cache-memory
targets: [!ref server]
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
secrets: { stripeWebhookSecret: { env: STRIPE_WEBHOOK_SECRET, type: string } }
---
kind: RateLimit.Budget
metadata: { name: authAttempts }
store: { kind: CacheMemory.Store }
limit: 50
window: "60s"
---
kind: Http.Api
metadata: { name: webhooks }
routes:
  - request: { path: /stripe, method: POST }
    maxBodyBytes: 65536
    handler: { kind: Telo.Value, value: { received: true } }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
    catches:
      - when: !cel "error.code == 'ERR_HTTP_AUTHENTICATION_THROTTLED'"
        status: 429
        headers: { Retry-After: !cel "string(error.data.retryAfter)" }
        content: { application/json: { body: { error: throttled } } }
  - request: { path: /refunds, method: POST }
    maxBodyBytes: 65536
    authentication:
      throttle: { budget: !ref authAttempts, key: !cel "request.ip + ':refunds'" }
    handler: { kind: Telo.Value, value: { received: true } }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /webhooks
    mount: !ref webhooks
    authentication:
      throttle: { budget: !ref authAttempts }
      verifiers:
        - verifier:
            kind: AuthSignature.Verifier
            keys:
              - { subject: stripe, algorithm: hmac-sha256, secret: !cel "secrets.stripeWebhookSecret" }
          from:
            kind: Http.FromBodySignature
            scheme: Stripe
            signature: { header: Stripe-Signature, pattern: "(?:^|,)v1=([0-9a-f]+)", encoding: hex }
            timestamp: { header: Stripe-Signature, pattern: "(?:^|,)t=(\\d+)", unit: seconds }
            base:
              - { header: Stripe-Signature, pattern: "(?:^|,)t=(\\d+)" }
              - { text: . }
              - { body: true }
```

What the caller sees:

```
$ curl -i -XPOST localhost:8080/webhooks/stripe -d '{}' -H 'Stripe-Signature: t=1700000000,v1=00'
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Stripe
$ # once 50 attempts from one address are in flight or refused within a minute
HTTP/1.1 429 Too Many Requests
Retry-After: 41
```

A timestamp older than `maxSignatureAge` is the same 401 (`stale`), and a changed body byte is `signature`. A GitHub recipe is the same shape with `signature: { header: X-Hub-Signature-256, pattern: "sha256=([0-9a-f]+)", encoding: hex }`, `base: [{ body: true }]` and no `timestamp:` block, so it carries no freshness. `telo check` refuses `Http.FromBodySignature` feeding `AuthBearer.Jwt` with `[CONTRACT_INPUTS_MISMATCH]`, an invalid `pattern` with `[SCHEMA_VIOLATION]`, and a route writing `throttle: { key: … }` with no `budget` with `[SCHEMA_VIOLATION]`.

**RFC 9421 inbound, and signing outbound.** A receiver that requires the method, target and body digest to be signed, with the partner's public key supplied as a JSON secret:

```yaml
kind: Telo.Application
metadata: { name: PartnerReceiver }
imports:
  Http: ../../modules/http-server
  AuthSignature: ../../modules/auth-signature
targets: [!ref server]
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
secrets:
  partnerPublicJwk:
    env: PARTNER_PUBLIC_JWK
    type: object
    required: [kty, crv, x]
    additionalProperties: false
    properties:
      kty: { const: OKP }
      crv: { const: Ed25519 }
      x: { type: string }
---
kind: Http.Api
metadata: { name: partnerRoutes }
routes:
  - request: { path: /orders, method: POST }
    maxBodyBytes: 65536
    handler: { kind: Telo.Value, value: { received: true } }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /partner
    mount: !ref partnerRoutes
    authentication:
      verifiers:
        - verifier:
            kind: AuthSignature.Verifier
            maxSignatureAge: "5m"
            clockTolerance: "30s"
            keys:
              - { id: partner, subject: partner, algorithm: ed25519, jwk: !cel "secrets.partnerPublicJwk" }
          from:
            kind: Http.FromMessageSignature
            scheme: Signature
            label: sig1
            components: ["@method", "@target-uri", content-digest]
```

The sender signs through its client's credential, and a webhook it sends is signed Standard Webhooks style with `Http.BodySignature`. The timestamp header is written before `base` is evaluated, so a `{ header }` part reads it, and the caller sets `webhook-id` itself:

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
        baseUrl: https://partner.example.com
        credential:
          kind: Http.MessageSignature
          keyId: partner
          algorithm: ed25519
          jwk: !cel "secrets.signingJwk"
          components: ["@method", "@target-uri", content-digest]
          expiresIn: "5m"
      url: /partner/orders
      method: POST
      body: { orderId: o_1 }
  - name: event
    invoke:
      kind: Http.Request
      client:
        kind: Http.Client
        baseUrl: https://hooks.example.com
        credential:
          kind: Http.BodySignature
          algorithm: hmac-sha256
          secret: !cel "bytesFromBase64(secrets.hookSecret.substring(6))"
          timestamp: { header: webhook-timestamp, unit: seconds }
          base: [{ header: webhook-id }, { text: . }, { header: webhook-timestamp }, { text: . }, { body: true }]
          signature: { header: webhook-signature, value: !interpolate "v1,${{ signature }}", encoding: base64 }
      url: /events
      method: POST
      headers: { webhook-id: evt_1 }
      body: { type: order.created }
```

A streamed body sent through either credential is refused at the call with `[ERR_HTTP_CREDENTIAL_BODY_STREAMED]`; a literal verifier `jwk` carrying `d`, or `crv: P-256`, is a `SCHEMA_VIOLATION` at `telo check`.

## Decisions

Constraints a reader would otherwise re-propose:

- **Single-use tokens are their own module, not a `kv-store` kind.** `kv-store` stays a storage contract with no protocol, as with `KeyedClaim`.
- **A signature presentation carries the signed bytes, not the request.** The verifier stays transport-neutral, as for every other presentation.
- **One generic body-signature source instead of a kind per vendor.** A vendor kind in `http-server` would name vendors in a generic module.
- **Throttling lives on the mount, counting refusals, not requests.** A request limit punishes legitimate traffic; a per-verifier wrapper cannot see the client address, which a transport-neutral verifier is never given. It reserves before authenticating, because a check-then-count design lets an attacker's concurrency multiply the budget.

## Bookkeeping

- **Docs:**
  - `modules/one-time/docs/`, `modules/auth-signature/docs/` and `modules/http-signature/docs/`, each with a README, `LICENSE` and `license: MIT`;
  - `http-server` `authentication.md` (the two sources and their `scheme`, body-before-authentication and the mount body rule, the meaning of `components`, freshness existing only where a source reads a timestamp, `throttle` with its sizing, shared store, `trustProxy`, that an IPv6 client holding a /64 gets one budget per address while `Protection.PasswordThrottle` still bounds per-account guessing, and the `stage: throttle` row);
  - `http-client` credential docs;
  - `auth` `presentations.md` (the fifth variant);
  - `protection` `password-throttle.md` (pointing at `throttle`);
  - `queue` `receiving-webhooks.md`, whose "verify the signature first" gains the recipe paired with `Idempotency.Once`;
  - recipes for Stripe, GitHub, Slack, Shopify and Standard Webhooks in `auth-signature`'s docs, each keyed on that vendor's event id: a header for GitHub, Shopify and Standard Webhooks, a field of the parsed body for Stripe and Slack.
- **Example:** `examples/order-webhook` switches from its bearer token to `Http.FromBodySignature` plus `AuthSignature.Verifier` (no `timestamp:` block). The `rejectUnknownSender` step, the handler's `token` input, the route's `authorization` header schema, the `ERR_WEBHOOK_UNAUTHORIZED` catch and the module description's curl are replaced; the secret becomes the signing secret; its tests sign their deliveries.
- **Primer and guides:** the primer (`apps/authoring-agent/chat/primer.md`), the hub `design-library` guide and `modules/CLAUDE.md` describe the three building blocks.
- **Ledger entries** in `docs/guides/what-you-get.md`, under Standard library, auth: single-use links and codes, verifying and signing webhooks and HTTP message signatures, and sign-in throttling per client. The "Request authentication with a typed caller" entry gains the signature sources.
- **Release:** one `Added` fragment per module: `one-time`, `auth-signature`, `http-signature`, `auth`, `http-server`, `http-client`, `protection`. No changeset, since no published npm package changes.
- **Floors:** the new vocabulary is added to each module's own kinds, so no module needs a floor for exposing it. Only a manifest writing new syntax that an older analyzer refuses declares one, found by running `telo release floor`.
- **Roadmap:** the identity roadmap drops the token mechanics from `passwordless`, `auth-signature` from phase 6 and per-IP lockout from `protection`.

## Verify

- **Single-use tokens**, on two applications sharing one `kv-store-sql` store over SQLite:
  - a link redeemed on one is `unknown` on the other, and a successful redemption answers the `subject` and `data`;
  - two concurrent redemptions of one link give exactly one `redeemed: true`;
  - reissuing for a subject makes the first token `unknown`, including when the process is killed between the issue writes (only the newest token redeems);
  - a bound link redeemed with the wrong holder answers `holderMismatch`, and still redeems afterwards with the right one;
  - a code answers `mismatch` four times, then `exhausted`, then `unknown`, even for the right code;
  - an expired token is `unknown`, and a revoked one too;
  - the store's rows contain neither the link token, the code nor the holder;
  - `Issue` with `data` violating `dataType` is refused by `telo check`, and so is `OneTime.RedeemCode` naming a `OneTime.Links`;
  - two sets with one `name` on one store are `ONE_TIME_NAME_DUPLICATE`, and running without checking fails with `ERR_ONE_TIME_NAME_DUPLICATE`.
- **Signed requests:**
  - published test deliveries from Stripe, GitHub, Slack, Shopify and Standard Webhooks verify through `Http.FromBodySignature` recipes, with `maxSignatureAge` set far enough for their recorded timestamps (a Standard Webhooks secret is `bytesFromBase64(…)`); staleness is tested separately with a freshly signed request;
  - one changed body byte is a 401 (`signature`) carrying `WWW-Authenticate` with the source's `scheme`;
  - a timestamp six minutes old is a 401 (`stale`); a Stripe request without `t=` is a 401 as malformed; a GitHub recipe with no `timestamp:` block verifies;
  - a presentation whose `alg` differs from its key's algorithm is refused (`algorithm`);
  - a redelivered webhook behind `Idempotency.Once` runs its effect once, on two replicas sharing the store;
  - the RFC 9421 Appendix B vectors for `hmac-sha256` and `ed25519` verify through `Http.FromMessageSignature` with `maxSignatureAge` set far enough for their recorded `created`, and one with its `created` removed fails as `signature`;
  - a `Content-Digest` that does not match the body is a 401;
  - a request signed by `Http.MessageSignature`, and a webhook signed by `Http.BodySignature`, verify against the matching inbound verifier, including a request with a body and one without;
  - a streamed body sent through either credential is `ERR_HTTP_CREDENTIAL_BODY_STREAMED`;
  - neither `http-server` nor `http-client` contains a signature-base or structured-field implementation; both resolve `http-signature`;
  - `telo check` refuses `Http.FromBodySignature` feeding `AuthBearer.Jwt` (`CONTRACT_INPUTS_MISMATCH`), an invalid RE2 `pattern`, a `components` entry carrying `;sf`, and a verifier `jwk` carrying `d`; an env secret declared `type: object` that is not a JSON object is refused at load naming the variable;
  - behind a body-signature source, a parsed route, a streamed-body route and `Mcp.HttpEndpoint` each receive the exact bytes that were verified; a body over the route's bound is a 413 and the verifier is not called.
- **Throttling:**
  - with a budget of 5 per minute, 50 concurrent wrong API keys from one address reach the verifier at most 5 times, and the sixth sequential wrong key is a 429 with `Retry-After` (its store sees no read);
  - 50 sequential requests with no credential from one address are all 401, and the next wrong key is still a 401, not a 429;
  - another address still gets 401 for a wrong key and 200 for a right one;
  - successful requests from the throttled address spend nothing once settled;
  - an unreachable verifier store is 503 and spends nothing;
  - a budget store that is down is 503 with `stage: throttle`, and the verifier is not called;
  - two applications sharing one budget store: 3 failures on one plus 2 on the other make the next a 429 on either;
  - the 429 is catchable in a route's `catches:`.
