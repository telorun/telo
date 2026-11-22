---
status: done
priority: medium
depends-on: []
packages: [modules/one-time, modules/auth, modules/auth-signature, modules/http-signature, modules/http-server, modules/protection, modules/queue, examples/order-webhook, apps/authoring-agent, apps/hub, docs]
refinement: not-ready
---

# Auth building blocks: single-use tokens, signed requests, sign-in throttling

## Problem

Three things every application with sign-in or webhooks needs are missing, and the identity roadmap had them inside domain modules.

- **Single-use tokens.** A password-reset link, an email-verification link, a magic link, an invitation or a typed one-time code is a secret that works once, expires and is tied to whoever it was issued for. Nothing in the standard library issues one. `oauth-client` keeps its own one-off record for a pending sign-in. Everyone else hand-builds the same thing over `KvStore.Store` and a `Crypto.Random`, usually without atomic redemption or attempt limits.
- **Signed requests.** Webhook providers sign each delivery with an HMAC over the body (Stripe, GitHub, Slack, Shopify, Standard Webhooks), and RFC 9421 signs HTTP messages in general. A mount's `authentication:` runs before the body is read, and no credential source or verifier understands signatures. So `queue`'s "receiving webhooks" guide says "verify the signature first" without being able to show how, and `examples/order-webhook` falls back to a shared bearer token.
- **Sign-in throttling per client.** `Protection.PasswordThrottle` limits guessing of one account. Its docs leave limiting per client address to "the server's rate limit on the route", which does not exist. Nothing stops one address from trying API keys, session ids or passwords against many accounts.

## Constraints

None.

## Surface

**Added**
- module `one-time` (`OneTime`) — single-use links and codes over a `KvStore.Store`.
- `OneTime.Tokens` — abstract token set: `name`, `store`, `expiresIn`, `dataType`, `reissueAfter`.
- `OneTime.Links` — a set of URL tokens; `bytes`.
- `OneTime.Codes` — a set of typed codes; `digits`, `maxAttempts`.
- `OneTime.Issue` — `{ subject, data?, holder? }` → `{ issued: true, token, expiresAt }` or `{ issued: false, retryAfter }`.
- `OneTime.RedeemLink` — `{ token, holder? }`; `OneTime.RedeemCode` — `{ subject, token, holder? }`; each → `{ redeemed: true, subject, data }` or `{ redeemed: false, reason }`.
- redemption reasons `unknown`, `holderMismatch`, `mismatch`, `exhausted`.
- `OneTime.Revoke` — `{ subject }` → `{ revoked }`.
- `tokens` — the reference slot on each `OneTime` operation naming its set.
- `ONE_TIME_NAME_DUPLICATE` / `ERR_ONE_TIME_NAME_DUPLICATE` — two sets claim one `name` on one store.
- `ERR_ONE_TIME_CONTENDED` — a write kept losing the race.
- `ERR_ONE_TIME_STORE_UNAVAILABLE` — the store threw.
- module `http-signature` (`HttpSignature`) — the shared signature grammar, through `exports.code`.
- `HttpSignature.BasePart` — named shape of a body-signature base part: `{ type: literal, value }`, `{ type: header, header, pattern? }`, `{ type: body }`.
- module `auth-signature` (`AuthSignature`) with `AuthSignature.Verifier` — `keys`, `maxSignatureAge`, `clockTolerance`.
- verifier refusal reasons `unknownKey`, `algorithm`, `signature`, `stale`, `expired`.
- `Auth.SignaturePresentation` — `type: signature`, `base`, `signatures`, `keyId`, `algorithm`, `created`, `expires`.
- `Http.FromMessageSignature` — RFC 9421 source: `label`, `components`, `scheme`.
- `Http.FromBodySignature` — webhook source: `signature: { header, pattern?, encoding }` (`hex` | `base64` | `base64url`), `timestamp: { header, pattern?, unit }` (`seconds` | `milliseconds`), `base`, `scheme`.
- reading member `readsBody` — published by a credential source that needs the body.
- `authentication.throttle: { budget, key? }` — on a mount and a route.
- `ERR_HTTP_AUTHENTICATION_THROTTLED` — 429 with `data: { retryAfter }`.

**Changed**
- `Auth.Presentation` — gains the `Auth.SignaturePresentation` variant.
- `Http.CredentialRequest` — gains optional `body` (sensitive) and `targetUri`.
- `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` and the `http.server.access_check.unavailable` log record — `stage` gains `throttle`.
- the access stage of `Http.Server` — reads the body before the sources run on a mount or route listing a `readsBody` source.
- `examples/order-webhook` — secret `webhookSecret` (`WEBHOOK_SECRET`), deliveries signed in `x-signature`.

**Removed**
- `examples/order-webhook`'s `webhookToken` (`WEBHOOK_TOKEN`), `ERR_WEBHOOK_UNAUTHORIZED` and the route's `authorization` header schema.

## Solution

### 1. `one-time` — single-use tokens (new module, `metadata.name: OneTime`)

**Token sets.** A set is a `Telo.Provider` with its own durable `name`, a `store` (`KvStore.Store`), a required `expiresIn` (`Telo.Duration`), a `reissueAfter` (`Telo.Duration`, default `60s`, `0s` for none) and an optional `dataType` (a `Telo.JsonSchema`, `x-telo-serializable`) for what each token carries. It comes in two kinds under the abstract `OneTime.Tokens`:
- `OneTime.Links` — a random secret sent in a URL. `bytes` defaults to 32 and is at least 16. The token is base64url.
- `OneTime.Codes` — a short code a person types. `digits` defaults to 6 (6–10). `maxAttempts` defaults to 5.

**Operations.** Each names its set through its `tokens` slot, so pairing an operation with the wrong kind of set is `REFERENCE_KIND_MISMATCH` before the app runs.
- `OneTime.Issue` (either kind): `{ subject, data?, holder? }`.
  - `subject` names who or what the token is for: an email, a user id, an invitation.
  - **A set holds at most one live token per subject.** Issuing again replaces the previous token, so "resend the code" invalidates the old one.
  - **Reissue waits `reissueAfter`.** An issue within `reissueAfter` of the subject's previous one answers `issued: false` and the previous token stays live. This bounds guessing at `maxAttempts` per `reissueAfter` per subject, and bounds the mail a caller can make the application send. A redeemed or revoked token does not hold the subject back.
  - `data` is held to the set's `dataType`.
  - `holder` is a value the redeemer must present again, such as an identifier set in the browser that asked.
  - `token` is sensitive.
- `OneTime.RedeemLink` (on `Links`): `{ token, holder? }`.
- `OneTime.RedeemCode` (on `Codes`): `{ subject, token, holder? }`.
- `OneTime.Revoke`: `{ subject }` → `{ revoked }`.

**What an operation answers.** Each output is a closed `anyOf` discriminated by a `const` boolean, as `Auth.PasswordVerifier`'s is, so a member of one branch is read with `.?member.orValue(…)`:
- Issue: `{ issued: true, token, expiresAt }` or `{ issued: false, retryAfter }` (whole seconds, at least 1).
- Redemption: `{ redeemed: true, subject, data }`, with `data` typed from the set's `dataType`, or `{ redeemed: false, reason }`, where `reason` is one of:
  - `unknown` — never issued, already used, replaced, revoked or expired; these are not told apart;
  - `holderMismatch` — the holder is checked before the token or code, and the token is **not** consumed (a code loses no attempt), so it can still be opened by the right holder;
  - `mismatch` — a wrong code, which uses up one attempt;
  - `exhausted` — the attempt that used up the last one; the code stops redeeming.

A refused issue or redemption is an outcome the page renders, never a throw.

**Storage.** One record per subject is the live token, and an index points at it.
- `<name>/t/<sha256(subject)>` holds the `subject` (a link redemption answers it), the digest of the token (for a code, digested together with the subject), `data`, the digest of `holder`, `issuedAt`, `expiresAt` and, for a code, the attempts left. A dump of the store yields no usable link; a code's digest can be brute-forced offline from a dump while the code lives, which is why a code set's `expiresIn` should be minutes.
- A link adds a lookup `<name>/l/<sha256(token)>` → the subject digest. The lookup grants nothing: a token is live only while the subject record holds its digest.
- **Issue** reads the subject record and answers `issued: false` while `reissueAfter` from its `issuedAt` has not passed. Otherwise it writes the new lookup, then replaces the subject record with one conditional write on the version it read, then deletes the old lookup. A crash leaves at most a lookup that reads as `unknown`, never two redeemable links. Two concurrent issues give one `issued: true`; the loser rereads and answers `issued: false`.
- **Redeeming a link** reads the lookup and the subject record, compares holder, digest and expiry, then makes one `compareAndDelete` on the subject record, so a token works exactly once across every replica sharing the store. A wrong code is one `compareAndSet` on the subject record. An exhausted code's record keeps its `issuedAt` and no token until `reissueAfter` from it has passed, so exhausting a code does not open an immediate reissue. A write that keeps losing the race is `ERR_ONE_TIME_CONTENDED`.
- A store that throws is `ERR_ONE_TIME_STORE_UNAVAILABLE`, with the thrown value as `cause`; a cancellation passes through. This is the same guard `session` has.
- Two sets claiming one `name` on one store are `ONE_TIME_NAME_DUPLICATE`, a resource rule with `coReferrers: /store` spanning both kinds, twinned by `ERR_ONE_TIME_NAME_DUPLICATE`.

**Dependencies:** `one-time` → `kv-store`. It imports no transport and no identity module.

### 2. Signed requests

**The presentation (`auth`).** `Auth.Presentation` gains a fifth variant, `Auth.SignaturePresentation`. Its `type` is `signature`, and it has these members:
- `base` — the exact bytes that were signed (`Telo.Bytes`);
- `signatures` — the signatures presented, as a list of bytes, since Stripe sends several during a secret rotation;
- `keyId`, `algorithm` — each nullable;
- `created`, `expires` — nullable `Telo.Timestamp`s.

`base` and `signatures` are `x-telo-sensitive`. The transport builds `base`, so the verifier never sees a request.

**One shared home for the grammar (`http-signature`, new module, `metadata.name: HttpSignature`, MIT, imports nothing).** It exposes through `exports.code` the RFC 9421 signature-base builder, the `Signature-Input` / `Signature` structured-field reader (RFC 9651), `Content-Digest` (RFC 9530) and the evaluator of body-signature base parts, and exports the named shape `HttpSignature.BasePart`. `http-server` imports it; it is a module of its own so outbound signing credentials in `http-client` can share the same grammar later. It imports no transport and no verifier.

**Reading the body before authentication (`http-server`).**
- The access stage — throttle, authentication, origin check, authorization, guard — runs once per request at the point where the server is about to read the body, as it does today.
- **On a mount or route whose `authentication:` lists a source publishing `readsBody: true`, the stage reads every request's body before the sources run**, bounded by the matched route's `maxBodyBytes`, else the server's (default 1 MiB). A longer body is refused with the existing 413 before any verifier runs. A mount entry gains no key of its own. Since such a mount buffers every request — a streamed upload above the bound included — the docs say to list a body-reading source on the mount or route that receives the signed requests, not on one that also takes uploads.
- **The buffered bytes become the request's payload.** Every parser — the server's and any a mount registers — and the streamed-body intake read them, so a parsed route, a streamed-body route, `Mcp.HttpEndpoint` and any other `Telo.Mount` receive exactly the bytes that were verified. The mount contract says a mount reads the body only through the server.
- A mount whose sources publish no `readsBody` keeps today's order and reads nothing early.
- `Http.CredentialRequest`, the credential-source input, gains optional `body` (`Telo.Bytes`, `x-telo-sensitive`, set only for a `readsBody` source) and `targetUri` (the absolute target URI with the query exactly as received; it shares the scheme and authority the server derives for DPoP's `uri`, which leaves the query out, so behind a proxy it is right only under a correct `trustProxy`, and it holds the full path including the mount prefix), so sources that do not read them are unaffected.

What a source receives, before and after (`body` set only for a `readsBody` source):

```json
{ "method": "POST", "path": "/partner/orders", "host": "api.acme.test", "headers": { "content-type": "application/json" }, "query": {}, "cookies": {}, "ip": "203.0.113.7", "tls": null, "clientCertificate": null }
```

```json
{ "method": "POST", "path": "/partner/orders", "host": "api.acme.test", "headers": { "content-type": "application/json" }, "query": {}, "cookies": {}, "ip": "203.0.113.7", "tls": null, "clientCertificate": null, "targetUri": "https://api.acme.test/partner/orders", "body": "eyJvcmRlcklkIjoib18xIn0" }
```

**Two credential sources (`http-server`, under `Http.CredentialSource`).** Both are generic. Vendor schemes are documented recipes, not kinds. Both take `scheme` (an `Http.AuthScheme`, as `Http.FromHeader` does), which is what the 401's `WWW-Authenticate` carries when a signature is refused.
- `Http.FromMessageSignature { label?, components, scheme }` reads RFC 9421 `Signature-Input` / `Signature`.
  - **Which signature it reads:** the one named `label`. Without a label, the request must carry exactly one signature, otherwise it is malformed.
  - **Required coverage:** the signature must cover every entry of `components`. These are derived components (`@method`, `@target-uri`, `@authority`, `@scheme`, `@request-target`, `@path`, `@query`, `@query-param;name=…`) and lower-case header field names; an entry of any other form, or one carrying `;sf`, `;bs`, `;key` or `;req`, is a `SCHEMA_VIOLATION` at `telo check`. A signature covering less is malformed. `components` is exactly what the signature authenticates: a list without `content-digest` leaves the body unauthenticated, which is what a signed `GET` wants.
  - **Base and members:** it builds the signature base of RFC 9421 §2.5 from `targetUri`. It takes `keyid`, `alg`, `created` and `expires` from the signature parameters; the `nonce` parameter is not read in this plan.
  - **Body:** when `content-digest` is covered, it checks `Content-Digest` (RFC 9530, `sha-256` / `sha-512`) against the body (an absent body is the empty one), and a mismatch is refused 401. A signature using a component parameter the source does not support is malformed.
  - It publishes `readsBody: true` only when `components` names `content-digest`.
- `Http.FromBodySignature { signature, timestamp?, base, scheme }` reads the webhook family.
  - `signature: { header, pattern?, encoding }` — `pattern` is an RE2 pattern (`format: re2-pattern`, checked by `telo check`) whose first group captures each signature, all matches taken. Without one, the whole header is the signature. `encoding` is `hex | base64 | base64url`.
  - `timestamp: { header, pattern?, unit: seconds | milliseconds }`, optional. A source that declares it treats a missing or unreadable timestamp as malformed; a source that does not (GitHub, Shopify) yields a presentation with no `created`.
  - `base`, an ordered list of `HttpSignature.BasePart`s joined with nothing between them: `{ type: literal, value }`, `{ type: header, header, pattern? }`, `{ type: body }`. The list must hold a `{ type: body }` part (`SCHEMA_VIOLATION` otherwise).
  - It always publishes `readsBody: true`.

A missing signature header is "no credential" for both sources. A present but unreadable one throws `ERR_HTTP_CREDENTIAL_MALFORMED`. Feeding either source to a verifier that cannot take a signature presentation is the existing `CONTRACT_INPUTS_MISMATCH`.

**The verifier — `auth-signature` (new module, `metadata.name: AuthSignature`).** `AuthSignature.Verifier` extends `Auth.Verifier` and takes `signature` presentations only.
- **`keys`** is a list of `{ id?, subject, algorithm, … }` where each key states its own `algorithm`, so no algorithm is ever chosen by the request:
  - `algorithm: hmac-sha256` takes `secret`, a sensitive string (used as its UTF-8 bytes) or `Telo.Bytes`; a base64 secret is `!cel "bytesFromBase64(…)"`;
  - `algorithm: ed25519` takes `jwk`, a JWK object of a closed OKP / Ed25519 shape written in the kind's own schema (a public key here: `kty`, `crv`, `x`, optional `kid`; a `d` is refused). A secret holding one is declared `type: object`, which the kernel decodes from its JSON env text.
  - A presentation with a `keyId` is checked against the key with that `id`. One without a `keyId` is tried against each key that has no `id`, each under its own algorithm, which covers secret rotation.
  - The presentation's `algorithm` (RFC 9421 `alg`) is a claim checked against the key's algorithm, never a selector.
- **Supported algorithms** are `hmac-sha256` and `ed25519`. Another is added later as one more enum value.
- **Freshness exists where `maxSignatureAge` is written**, as `AuthBearer.Jwt`'s `maxTokenAge` does. It has no default. Written, a presentation with no `created` or one older than the age is refused `stale`, whichever source fed it. `clockTolerance` defaults to 30 seconds. A passed `expires` is always refused `expired`.
- **Principal:** an accepted signature yields `kind: service` with `subject` from the matching key.
- **Refusals** are `unknownKey`, `algorithm`, `signature`, `stale` and `expired`. Each comes with a null challenge, and the verifier publishes `challenges: []` and no `issuer`.
- **Comparisons:** every comparison is constant-time.
- **Replay is the receiver's idempotency, not the verifier's.** Providers redeliver the same signed delivery on a 5xx, so a verifier that refused a repeat would lose the event. A handler dedupes on the provider's delivery id with `Idempotency.Once`; each vendor recipe pairs the two.

**Dependencies:** `auth-signature` → `auth`. It imports no transport. `http-server` → `http-signature`.

### 3. Throttling sign-in per client (`http-server`)

`authentication:` gains `throttle: { budget, key? }`.
- `budget` (required) is a `RateLimit.Budget`, the kind `Protection.PasswordThrottle.budget` names. Its `limit` and `window` say how many attempts are in flight or refused per window.
- `key` is evaluated per request over `request`, typed as `Http.CredentialRequest`, before any body is read (so its `body` is null there), and defaults to `request.ip`, the server's client address, which is correct only under a correct `trustProxy`.
- A route's `authentication.throttle` replaces the mount's whole, as every other `authentication` key a route writes does; a route writing only `key` is a `SCHEMA_VIOLATION`. A budget shared by mount and route is a named resource referenced from both, and a budget has no namespace of its own on its store, so a route keeps its own counter by suffixing the key, and the docs say every limiter on one `Cache.Store` shares its keyspace.

**Per request:**
1. **The reservation comes before any cost.** Behind header-only sources the server reserves 1 under the key once a source answers with a credential, before its verifier runs; a request carrying no credential touches no store. Behind a `readsBody` source it reserves before the body is read, for every request.
2. **A spent budget** is answered 429 with `Retry-After` from the budget, code `ERR_HTTP_AUTHENTICATION_THROTTLED`, `data: { retryAfter }`. No body is read and no verifier runs, so a throttled client costs no password hash, no store read and no buffer.
3. **Settling:** an accepted credential, a verifier that throws, and a request every source answers with no credential settle the reservation to 0. A refused or malformed credential, a 413 and an aborted upload leave it spent. The throttle counts guesses, not requests.
4. **A budget store that throws**, on the reserve or on the settle, answers `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` (503) with `data.stage: throttle` and the store's error as `cause`; the throttle never fails open. When the verifier threw too, the answer stays `stage: verifier`, and the settle's failure is in the same `http.server.access_check.unavailable` record.

**Sizing.** The reservation is atomic, so parallel wrong guesses from one address can never exceed `limit`. The price is that `limit` also counts requests still inside the access stage, including a `readsBody` upload: size it as the peak concurrent such requests per key plus the failures allowed. In-flight buffers per key are capped at `limit` × the body bound. A budget over a process-local `Cache.Store` bounds each replica separately; a fleet-wide bound needs a shared store.

The code is raised into the route, router and server `catches:` lists through `x-telo-catches-for`, beside the four existing refusals, and has a built-in problem body carrying `Retry-After`. This throttle covers every verifier on every `Telo.Mount`. `Protection.PasswordThrottle` stays the per-account half, and its docs now point here instead of at a rate limit that did not exist.

**Dependencies:** `http-server` → `rate-limit` (new edge; `rate-limit` imports only `cache`).

## Examples

**Single-use tokens: a bound reset link, a typed code, revoking.** The `Console` steps stand in for a mailer. A `Telo.Sequence` without `outputs:` answers the map of its step results, so the issue routes read `result.issue`.

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
kind: KvStore.Store
metadata: { name: tokenStore }
---
kind: OneTime.Links
metadata: { name: resetLinks }
name: password-reset
store: !ref tokenStore
bytes: 32
expiresIn: 30m
reissueAfter: 2m
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
store: !ref tokenStore
expiresIn: 10m
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
          if: !cel "steps.issue.result.issued"
          then:
            - name: mail
              invoke: !ref Console.writeLine
              inputs:
                output: !interpolate "reset link for ${{ inputs.email }}: /reset/${{ steps.issue.result.?token.orValue('') }}"
    inputs:
      email: !cel "request.body.email"
      returnTo: !cel "request.body.returnTo"
      browserId: !cel "request.headers['x-browser-id']"
    returns:
      - when: !cel "result.issue.issued"
        status: 202
        content: { application/json: { body: { sent: true } } }
      - when: !cel "!result.issue.issued"
        status: 429
        headers: { Retry-After: !cel "string(result.issue.?retryAfter.orValue(1))" }
        content: { application/json: { body: { retryAfter: !cel "result.issue.?retryAfter.orValue(1)" } } }
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
    catches:
      - when: !cel "error.code == 'ERR_ONE_TIME_STORE_UNAVAILABLE' || error.code == 'ERR_ONE_TIME_CONTENDED'"
        status: 503
        headers: { Retry-After: "2" }
        content: { application/json: { body: { error: try_again } } }
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
        # Issued for every email, existing or not, so no answer reveals which accounts exist.
        - name: issue
          invoke: { kind: OneTime.Issue, tokens: !ref signInCodes }
          inputs: { subject: !cel "inputs.email", holder: !cel "inputs.browserId" }
        - name: send
          if: !cel "steps.issue.result.issued"
          then:
            - name: mail
              invoke: !ref Console.writeLine
              inputs:
                output: !interpolate "sign-in code for ${{ inputs.email }}: ${{ steps.issue.result.?token.orValue('') }}"
    inputs:
      email: !cel "request.body.email"
      browserId: !cel "request.headers['x-browser-id']"
    returns:
      - when: !cel "result.issue.issued"
        status: 202
        content: { application/json: { body: { sent: true } } }
      - when: !cel "!result.issue.issued"
        status: 429
        headers: { Retry-After: !cel "string(result.issue.?retryAfter.orValue(1))" }
        content: { application/json: { body: { retryAfter: !cel "result.issue.?retryAfter.orValue(1)" } } }
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
      token: !cel "request.body.code"
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

What a client sees (the link token is read from the console line):

```
$ curl -s localhost:8080/auth/resets -H 'x-browser-id: b1' -H 'content-type: application/json' -d '{"email":"ann@acme.test","returnTo":"/settings"}'
{"sent":true}
$ curl -si localhost:8080/auth/resets -H 'x-browser-id: b1' -H 'content-type: application/json' -d '{"email":"ann@acme.test","returnTo":"/settings"}'
HTTP/1.1 429 Too Many Requests
Retry-After: 117

{"retryAfter":117}
$ curl -s localhost:8080/auth/resets/redeem -H 'x-browser-id: b2' -H 'content-type: application/json' -d '{"token":"Qm9yaW5nLXJhbmRvbS10b2tlbi1mb3ItYW5u"}'
{"redeemed":false,"reason":"holderMismatch"}
$ curl -s localhost:8080/auth/resets/redeem -H 'x-browser-id: b1' -H 'content-type: application/json' -d '{"token":"Qm9yaW5nLXJhbmRvbS10b2tlbi1mb3ItYW5u"}'
{"redeemed":true,"subject":"ann@acme.test","data":{"returnTo":"/settings"}}
$ curl -s localhost:8080/auth/resets/redeem -H 'x-browser-id: b1' -H 'content-type: application/json' -d '{"token":"Qm9yaW5nLXJhbmRvbS10b2tlbi1mb3ItYW5u"}'
{"redeemed":false,"reason":"unknown"}
```

Four wrong guesses at a code answer `mismatch`; the fifth is `{ "redeemed": false, "reason": "exhausted" }`, after which even the right code is `unknown`, and `/auth/codes` answers 429 until `reissueAfter` from the first issue has passed. A guess from another browser is `holderMismatch` and costs no attempt. Mistakes in the manifest are refused before the app runs — pointing the code route's handler at `resetLinks`, an issue whose `data` misses `returnTo`, and a second set named `password-reset` on `tokenStore`:

```
$ telo check ./manifest.yaml
manifest.yaml: routes[4].handler.tokens: [REFERENCE_KIND_MISMATCH] OneTime.RedeemCode needs a OneTime.Codes, got OneTime.Links
manifest.yaml: routes[0].handler.steps[0].inputs.data: [SCHEMA_VIOLATION] must have required property 'returnTo'
manifest.yaml: signInCodes.name: [ONE_TIME_NAME_DUPLICATE] OneTime.Codes signInCodes and OneTime.Links resetLinks both claim the name 'password-reset' on store tokenStore
```

**Throttling password sign-in per address, beside the per-account throttle.** `Protection.PasswordThrottle` bounds guesses at one account; the mount's `throttle` bounds one address trying many accounts. A request without `Authorization` is challenged and spends nothing.

```yaml
kind: Telo.Application
metadata: { name: Intranet }
imports:
  Http: ../../modules/http-server
  AuthBasic: ../../modules/auth-basic
  Identity: ../../modules/identity
  Protection: ../../modules/protection
  Crypto: ../../modules/crypto
  RateLimit: ../../modules/rate-limit
  CacheMemory: ../../modules/cache-memory
targets: [!ref server]
ports: { http: { env: PORT, protocol: tcp, default: 8080 } }
secrets: { annHash: { env: ANN_PASSWORD_HASH, type: string } }
---
kind: CacheMemory.Store
metadata: { name: counters }
---
kind: Http.Api
metadata: { name: pages }
routes:
  - request: { path: /me, method: GET }
    handler: { kind: Telo.Value, value: { ok: true } }
    returns:
      - status: 200
        content: { application/json: { body: !cel "result" } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /
    mount: !ref pages
    authentication:
      throttle:
        budget: { kind: RateLimit.Budget, store: !ref counters, limit: 20, window: "10m" }
      verifiers:
        - verifier:
            kind: AuthBasic.Verifier
            realm: intranet
            passwords:
              kind: Protection.PasswordThrottle
              budget: { kind: RateLimit.Budget, store: !ref counters, limit: 5, window: "15m" }
              passwords:
                kind: Identity.DeclaredUsers
                hasher: { kind: Crypto.PasswordHash, algorithm: bcrypt }
                users: { ann: { passwordHash: !cel "secrets.annHash" } }
          from: { kind: Http.FromAuthorization, schemes: [Basic] }
```

```
$ curl -si localhost:8080/me
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="intranet", charset="UTF-8"
$ # after 20 wrong passwords from this address across any accounts within ten minutes
$ curl -si -u bob:guess localhost:8080/me
HTTP/1.1 429 Too Many Requests
Retry-After: 512
$ curl -si localhost:8080/me
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="intranet", charset="UTF-8"
```

**Verifying a Stripe webhook, with a throttle.** The budget is a named resource because the mount and a route both use it. `/stripe` renders the throttle refusal itself; `/refunds` leaves it to the built-in problem body, which carries the same 429 and `Retry-After`. Redeliveries are the handler's to dedupe with `Idempotency.Once` keyed on the provider's event id, which `examples/order-webhook` shows after this change.

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
            maxSignatureAge: "5m"
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

What the caller sees:

```
$ curl -i -XPOST localhost:8080/webhooks/stripe -d '{}' -H 'Stripe-Signature: t=1700000000,v1=00'
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Stripe
$ # once 50 attempts from one address are in flight or refused within a minute
$ curl -i -XPOST localhost:8080/webhooks/stripe -d '{}' -H 'Stripe-Signature: t=1700000000,v1=00'
HTTP/1.1 429 Too Many Requests
Retry-After: 41

{"error":"throttled"}
$ # with the budget over a shared store (cache-redis) that is down
$ curl -i -XPOST localhost:8080/webhooks/refunds -d '{}' -H 'Stripe-Signature: t=1700000000,v1=00'
HTTP/1.1 503 Service Unavailable
```

The 503 is `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` with `data.stage: throttle`, rendered by the built-in problem body. A timestamp older than `maxSignatureAge` is the same 401 (`stale`), and a changed body byte is `signature`. A GitHub recipe is the same shape with `signature: { header: X-Hub-Signature-256, pattern: "sha256=([0-9a-f]+)", encoding: hex }`, `base: [{ type: body }]`, no `timestamp:` block and no `maxSignatureAge`, so it carries no freshness. `telo check` refuses, in turn: the verifier replaced by an `AuthBearer.Jwt`, the signature `pattern` changed to `v1=(`, the `{ type: body }` part removed from `base`, and the `/refunds` throttle reduced to its `key`:

```
$ telo check ./manifest.yaml
manifest.yaml: mounts[0].authentication.verifiers[0].from: [CONTRACT_INPUTS_MISMATCH] AuthBearer.Jwt takes token presentations; Http.FromBodySignature yields signature presentations
manifest.yaml: mounts[0].authentication.verifiers[0].from.signature.pattern: [SCHEMA_VIOLATION] must match format "re2-pattern"
manifest.yaml: mounts[0].authentication.verifiers[0].from.base: [SCHEMA_VIOLATION] must contain a { type: body } part
manifest.yaml: routes[1].authentication.throttle: [SCHEMA_VIOLATION] must have required property 'budget'
```

**RFC 9421 inbound.** A receiver that requires the method, target and body digest to be signed within five minutes, with the partner's public key supplied as a JSON secret:

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

A request the partner signed correctly but without `created` is refused, since `maxSignatureAge` is written:

```
$ curl -i -XPOST localhost:8080/partner/orders -H 'content-type: application/json' -d '{"orderId":"o_1"}' \
    -H 'Content-Digest: sha-256=:Pz8LBMtt3gVgPUhb2IJAEsy3n2QyuP7Tx2v1tC3dUjM=:' \
    -H 'Signature-Input: sig1=("@method" "@target-uri" "content-digest");keyid="partner";alg="ed25519"' \
    -H 'Signature: sig1=:2eL6VfF0kB3SNGJ6lyxo4ZxRRumdzeqYz9HgsMQ1Na1yhSEOQvX6Mv1OGTA+QY4dHyyYhNDmeB2bIvYXfrfeCQ==:'
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Signature
```

In the receiver, a literal verifier `jwk` carrying `d`, one with `crv: P-256`, and `components` holding `"content-digest;sf"` are refused before the app runs:

```
$ telo check ./partner-receiver.yaml
partner-receiver.yaml: mounts[0].authentication.verifiers[0].verifier.keys[0].jwk.d: [SCHEMA_VIOLATION] must NOT have additional properties
partner-receiver.yaml: mounts[0].authentication.verifiers[0].verifier.keys[0].jwk.crv: [SCHEMA_VIOLATION] must be equal to constant 'Ed25519'
partner-receiver.yaml: mounts[0].authentication.verifiers[0].from.components[2]: [SCHEMA_VIOLATION] must be a derived component or a lower-case field name without parameters
```

**`examples/order-webhook` after the change.** The Before is the example as it ships: `secrets.webhookToken`, a route requiring an `authorization` header, and a `handleDelivery` sequence whose `rejectUnknownSender` step compares the header and throws `ERR_WEBHOOK_UNAUTHORIZED`, caught as a 401. After, the server verifies a GitHub-style signature before the body is parsed and the route's handler is `Idempotency.Once` itself. Since the file is rewritten, its single-use resources (`claims`, `recordOrder`, `recordOrderOnce`, the two tables, `shipPending`, `openDocs`) are declared inline, and `/docs` declares `authentication: { anonymous: allow }`, which a server guarding a mount requires of its other mounts:

```yaml
kind: Telo.Application
metadata:
  name: OrderWebhook
  version: 1.0.0
  categories: [Transport, Reliability, Scheduling]
  description: |
    A webhook receiver that survives the things webhooks actually do to you:
    forged deliveries, redelivery, bursts, and work that must not block the response.

    The server checks each delivery's HMAC signature before the body is parsed.
    Providers retry until they get a 2xx, so the same delivery arrives more than
    once: `Idempotency.Once` claims the delivery id, runs the body at most once and
    replays the stored result for every retry. Fulfilment is drained in the
    background by a `Schedule.Interval`, so the provider gets its 202 immediately.

    Run, then sign and send the same delivery twice:
        body='{"deliveryId":"dlv_1","orderId":"ord_1","amountCents":4999,"currency":"EUR"}'
        sig=$(printf %s "$body" | openssl dgst -sha256 -hmac local-dev-secret | cut -d' ' -f2)
        curl -s -XPOST localhost:8099/webhooks/orders -H 'content-type: application/json' \
          -H "x-signature: sha256=$sig" -d "$body"
    The first reply says "fresh", the second "replayed".
requires:
  telo: ">=0.133.0"
imports:
  Http: ../../modules/http-server
  AuthSignature: ../../modules/auth-signature
  Sql: ../../modules/sql
  SQLite: ../../modules/sqlite
  Idempotency: ../../modules/idempotency
  KvStore: ../../modules/kv-store-memory
  Schedule: ../../modules/scheduler
  Console: ../../modules/console
targets:
  - !ref migrate
  - !ref server
  - { name: openDocs, invoke: { kind: Telo.OpenUrl }, inputs: { url: !interpolate "http://localhost:${{ ports.http }}/docs/" } }
  - !ref sweeper
ports: { http: { env: PORT, protocol: tcp, default: 8099 } }
variables:
  sweepEvery: { env: SWEEP_EVERY, type: string, default: "3s" }
  dbFile:
    env: DB_FILE
    type: string
    x-telo-type: { name: Telo.HostPath, entry: file }
    default: orders.db
secrets: { webhookSecret: { env: WEBHOOK_SECRET, type: string, default: local-dev-secret } }
---
kind: SQLite.Connection
metadata: { name: db }
file: !cel "variables.dbFile"
---
kind: SQLite.Schema
metadata: { name: migrate }
connection: !ref db
tables:
  - kind: SQLite.Table
    table: orders
    columns:
      order_id: { type: text, primaryKey: true }
      amount_cents: { type: integer, nullable: false }
      currency: { type: text, nullable: false }
      received_at: { type: text, nullable: false, defaultExpression: "datetime('now')" }
  - kind: SQLite.Table
    table: fulfilments
    columns:
      id: { type: integer, primaryKey: true, identity: always }
      order_id: { type: text, nullable: false }
      status: { type: text, nullable: false, default: pending }
      sent_at: { type: text }
---
kind: Sql.Command
metadata: { name: exec }
connection: !ref db
---
kind: Sql.Query
metadata: { name: query }
connection: !ref db
---
kind: Http.Api
metadata: { name: webhookRoutes }
routes:
  - request:
      path: /orders
      method: POST
      schema:
        body:
          type: object
          additionalProperties: false
          required: [deliveryId, orderId, amountCents, currency]
          properties:
            deliveryId: { type: string, minLength: 1 }
            orderId: { type: string, minLength: 1 }
            amountCents: { type: integer, minimum: 1 }
            currency: { type: string, minLength: 3, maxLength: 3 }
    maxBodyBytes: 16384
    handler:
      kind: Idempotency.Once
      store: { kind: KvStore.Store }
      claimTtl: "30s"
      ttl: "24h"
      invoke:
        kind: Telo.Sequence
        inputType:
          kind: Telo.JsonSchema
          schema:
            type: object
            required: [orderId, amountCents, currency]
            properties: { orderId: { type: string }, amountCents: { type: integer }, currency: { type: string } }
        steps:
          - name: insertOrder
            invoke: !ref exec
            inputs:
              sql: "INSERT INTO orders (order_id, amount_cents, currency) VALUES (?, ?, ?)"
              bindings: [!cel "inputs.orderId", !cel "inputs.amountCents", !cel "inputs.currency"]
          - name: enqueueFulfilment
            invoke: !ref exec
            inputs:
              sql: "INSERT INTO fulfilments (order_id) VALUES (?)"
              bindings: [!cel "inputs.orderId"]
        outputs:
          orderId: !cel "inputs.orderId"
    inputs:
      key: !cel "request.body.deliveryId"
      inputs:
        orderId: !cel "request.body.orderId"
        amountCents: !cel "request.body.amountCents"
        currency: !cel "request.body.currency"
    returns:
      - status: 202
        content:
          application/json:
            body: { orderId: !cel "result.result.orderId", state: !cel "result.state" }
    catches:
      - when: !cel "error.code == 'ERR_CLAIM_LOST'"
        status: 503
        headers: { Retry-After: "5" }
        content: { application/json: { body: { error: retry_later } } }
      - status: 500
        content: { application/json: { body: { error: !cel "error.code" } } }
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
openapi: { info: { title: Order webhook, version: 1.0.0 } }
mounts:
  - path: /webhooks
    mount: !ref webhookRoutes
    authentication:
      verifiers:
        - verifier:
            kind: AuthSignature.Verifier
            keys:
              - { subject: orders, algorithm: hmac-sha256, secret: !cel "secrets.webhookSecret" }
          from:
            kind: Http.FromBodySignature
            scheme: Signature
            signature: { header: x-signature, pattern: "sha256=([0-9a-f]+)", encoding: hex }
            base: [{ type: body }]
  - path: /docs
    mount: { kind: Http.Reference }
    authentication: { anonymous: allow }
---
kind: Schedule.Interval
metadata: { name: sweeper }
every: !cel "duration(variables.sweepEvery)"
invoke:
  kind: Telo.Sequence
  steps:
    - name: pending
      invoke: !ref query
      inputs:
        sql: "SELECT id, order_id FROM fulfilments WHERE status = 'pending' ORDER BY id LIMIT 20"
        bindings: []
    - name: ship
      if: !cel "size(steps.pending.result.rows) > 0"
      then:
        - name: mark
          invoke: !ref exec
          inputs:
            sql: "UPDATE fulfilments SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE status = 'pending'"
            bindings: []
        - name: report
          invoke: !ref Console.writeLine
          inputs:
            output: !interpolate "{dim shipped ${{ size(steps.pending.result.rows) }} fulfilment(s)}"
```

What a sender sees:

```
$ body='{"deliveryId":"dlv_1","orderId":"ord_1","amountCents":4999,"currency":"EUR"}'
$ sig=$(printf %s "$body" | openssl dgst -sha256 -hmac local-dev-secret | cut -d' ' -f2)
$ curl -s -XPOST localhost:8099/webhooks/orders -H 'content-type: application/json' -H "x-signature: sha256=$sig" -d "$body"
{"orderId":"ord_1","state":"fresh"}
$ curl -s -XPOST localhost:8099/webhooks/orders -H 'content-type: application/json' -H "x-signature: sha256=$sig" -d "$body"
{"orderId":"ord_1","state":"replayed"}
$ curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:8099/webhooks/orders -H 'content-type: application/json' -H 'x-signature: sha256=00' -d "$body"
401
```

## Decisions

Constraints a reader would otherwise re-propose:

- **Single-use tokens are their own module, not a `kv-store` kind.** `kv-store` stays a storage contract with no protocol, as with `KeyedClaim`.
- **The reissue bound lives in the set, not in a route guard.** A guard is optional, keyed per client and held in an evictable cache, so `maxAttempts` would mean nothing without it.
- **A signature presentation carries the signed bytes, not the request.** The verifier stays transport-neutral, as for every other presentation.
- **One generic body-signature source instead of a kind per vendor.** A vendor kind in `http-server` would name vendors in a generic module.
- **A body-reading source works behind every mount, not only `Http.Api` routes.** `authentication:` is a mount seam; restricting it would leave `Mcp.HttpEndpoint` and third-party mounts unsignable.
- **Freshness is configured on the verifier.** A source-level required-parameters list would leave a verifier stating an age behind a source with no timestamp unprotected.
- **Throttling lives on the mount, counting refusals, not requests.** A request limit punishes legitimate traffic; a per-verifier wrapper cannot see the client address, which a transport-neutral verifier is never given. It reserves before the verifier runs or a body is read, because counting after the verdict lets an attacker's concurrency multiply the budget.

## Bookkeeping

- **Docs:**
  - `modules/one-time/docs/`, `modules/auth-signature/docs/` and `modules/http-signature/docs/`, each with a README, `LICENSE` and `license: MIT`; `one-time`'s state the guessing bound (`maxAttempts` per `reissueAfter` per subject), that a caller reissuing for a victim can keep them waiting `reissueAfter`, and the `.?member.orValue(…)` reads of an outcome; a section "Hiding whether an account exists": an app that hides it calls `OneTime.Issue` for every subject it is asked about, sends mail only to real accounts and answers independently of the account, so `holderMismatch`, `mismatch`, `exhausted` and `issued: false` then reveal nothing — plus the timing channel the mail can open;
  - `http-server` `authentication.md`: the two sources and their `scheme`; that `@scheme`, `@authority` and `@target-uri` come from `targetUri`, so a receiver behind a TLS-terminating proxy needs a correct `trustProxy` or every signature fails; a mount listing a `readsBody` source buffering every request, where to list one, and the mount rule (a mount reads the body only through the server); the meaning of `components`; `throttle` with its sizing (requests inside the access stage, uploads included), the shared keyspace of a `Cache.Store`, shared stores and `trustProxy`; that an IPv6 client holding a /64 gets one budget per address while `Protection.PasswordThrottle` still bounds per-account guessing; the `stage: throttle` row covering the reserve and the settle;
  - `auth` `presentations.md` (the fifth variant);
  - `protection` `password-throttle.md` (pointing at `throttle`);
  - `queue` `receiving-webhooks.md`, whose "verify the signature first" gains the recipe paired with `Idempotency.Once`;
  - recipes for Stripe, GitHub, Slack, Shopify and Standard Webhooks in `auth-signature`'s docs, each keyed on that vendor's event id: a header for GitHub, Shopify and Standard Webhooks, a field of the parsed body for Stripe and Slack. The Stripe, Slack and Standard Webhooks recipes write `maxSignatureAge: 5m`; the GitHub and Shopify ones write none.
- **Example:** `examples/order-webhook` becomes the manifest above; its tests sign their deliveries.
- **Primer and guides:** the primer (`apps/authoring-agent/chat/primer.md`), the hub `design-library` guide and `modules/CLAUDE.md` describe the three building blocks, with `readsBody` beside the other reading members and the "issue for every subject" rule for apps hiding account existence.
- **Ledger entries** in `docs/guides/what-you-get.md`, under Standard library, auth: single-use links and codes, verifying webhooks and HTTP message signatures, and sign-in throttling per client. The "Request authentication with a typed caller" entry gains the signature sources.
- **Release:** one `Added` fragment per module: `one-time`, `auth-signature`, `http-signature`, `auth`, `http-server`, `protection`, `queue`. No changeset, since no published npm package changes.
- **Floors:** the new vocabulary is added to each module's own kinds, so no module needs a floor for exposing it. Only a manifest writing new syntax that an older analyzer refuses declares one, found by running `telo release floor`.
- **Roadmap:** the identity roadmap drops the token mechanics from `passwordless`, `auth-signature` from phase 6 and per-IP lockout from `protection`.

## Verify

- **Single-use tokens**, on two applications sharing one `kv-store-sql` store over SQLite:
  - a link redeemed on one is `unknown` on the other, and a successful redemption answers the `subject` and `data`;
  - two concurrent redemptions of one link give exactly one `redeemed: true`;
  - reissuing for a subject after `reissueAfter` makes the first token `unknown`, including when the process is killed between the issue writes (only the newest token redeems);
  - a second issue within `reissueAfter` answers `{ issued: false, retryAfter }` and the first token still redeems; two concurrent issues on two applications give exactly one `issued: true`;
  - a bound link or code redeemed with the wrong holder answers `holderMismatch`, a code loses no attempt to it, and both still redeem afterwards with the right holder;
  - a code answers `mismatch` four times, then `exhausted`, then `unknown`, even for the right code; an issue right after exhaustion answers `issued: false`;
  - an expired token is `unknown`, and a revoked one too; a subject issues again at once after its token is redeemed or revoked;
  - the store's rows contain neither the link token, the code nor the holder;
  - the plan's token example passes `telo check`; `Issue` with `data` violating `dataType` is refused, and so is `OneTime.RedeemCode` naming a `OneTime.Links`;
  - two sets with one `name` on one store are `ONE_TIME_NAME_DUPLICATE`, and running without checking fails with `ERR_ONE_TIME_NAME_DUPLICATE`;
  - the token example run with a mail step only for one known email: the known and an unknown email get the same issue response, the same `issued: false` within `reissueAfter`, and the same redemption reason for a made-up holder, for the requester's own holder with a wrong code, and after exhaustion; only the known one is mailed.
- **Signed requests:**
  - published test deliveries from Stripe, GitHub, Slack, Shopify and Standard Webhooks verify through `Http.FromBodySignature` recipes, with `maxSignatureAge` set far enough for their recorded timestamps where the recipe writes one (a Standard Webhooks secret is `bytesFromBase64(…)`); staleness is tested separately with a freshly signed request;
  - one changed body byte is a 401 (`signature`) carrying `WWW-Authenticate` with the source's `scheme`;
  - a timestamp six minutes old is a 401 (`stale`); a Stripe request without `t=` is a 401 as malformed; a GitHub recipe without `maxSignatureAge` verifies, and with it every delivery is `stale`;
  - a presentation whose `alg` differs from its key's algorithm is refused (`algorithm`);
  - a redelivered webhook behind `Idempotency.Once` runs its effect once, on two replicas sharing the store;
  - the RFC 9421 Appendix B vectors for `hmac-sha256` and `ed25519` verify through `Http.FromMessageSignature` with `maxSignatureAge` set far enough for their recorded `created`; one with its `created` removed fails as `signature`; a vector signed with no `created` verifies without `maxSignatureAge` and is `stale` with it;
  - a `Content-Digest` that does not match the body is a 401;
  - `http-server` contains no signature-base or structured-field implementation; it resolves `http-signature`;
  - `telo check` refuses `Http.FromBodySignature` feeding `AuthBearer.Jwt` (`CONTRACT_INPUTS_MISMATCH`), an invalid RE2 `pattern`, a `base` with no `{ type: body }` part, a `components` entry carrying `;sf`, and a verifier `jwk` carrying `d`; an env secret declared `type: object` that is not a JSON object is refused at load naming the variable;
  - behind a body-signature source, a parsed route, a streamed-body route, `Mcp.HttpEndpoint` and a fixture mount registering its own content-type parser each receive the exact bytes that were verified; a body over the route's bound is a 413 and the verifier is not called; a mount with header-only sources keeps today's refusal order and buffers nothing early;
  - no trace span or inspect payload of a signed request holds its body;
  - `examples/order-webhook`'s tests send signed deliveries, a redelivery (`replayed`) and a badly signed one (401).
- **Throttling:**
  - with a budget of 5 per minute, 50 concurrent wrong API keys from one address reach the verifier at most 5 times, and the sixth sequential wrong key is a 429 with `Retry-After` (its verifier's store sees no read);
  - on a header-only mount, 50 sequential requests with no credential from one address are all 401 and cause no budget-store call, and the next wrong key is still a 401, not a 429;
  - another address still gets 401 for a wrong key and 200 for a right one;
  - successful requests from the throttled address spend nothing once settled;
  - an unreachable verifier store is 503 and spends nothing;
  - a budget store that is down is 503 with `stage: throttle`, and the verifier is not called; a store that fails only on the settle is 503 `stage: throttle` for a valid credential; a throwing verifier with a failing settle is `stage: verifier`, with both errors in one log record;
  - two applications sharing one budget store: 3 failures on one plus 2 on the other make the next a 429 on either;
  - the 429 is catchable in a route's `catches:`, and without a catch carries `Retry-After` in the built-in problem.
