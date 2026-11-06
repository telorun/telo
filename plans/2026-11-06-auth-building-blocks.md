---
status: draft
priority: medium
depends-on: []
packages: [modules/one-time, modules/auth, modules/auth-signature, modules/http-server, modules/http-client, modules/protection, examples/order-webhook, apps/authoring-agent, apps/hub, docs]
---

# Auth building blocks: single-use tokens, signed requests, sign-in throttling

## Problem

Three things every application with sign-in or webhooks needs are missing, and the identity roadmap had them inside domain modules.

- **Single-use tokens.** A password-reset link, an email-verification link, a magic link, an invitation or a typed one-time code is a secret that works once, expires and is tied to whoever it was issued for. Nothing in the standard library issues one. `oauth-client` keeps its own one-off record for a pending sign-in. Everyone else hand-builds the same thing over `KvStore.Store` and a `Crypto.Random`, usually without atomic redemption or attempt limits.
- **Signed requests.** Webhook providers sign each delivery with an HMAC over the body (Stripe, GitHub, Slack, Shopify, Standard Webhooks), and RFC 9421 signs HTTP messages in general. A mount's `authentication:` runs before the body is read, and no credential source or verifier understands signatures. So `queue`'s "receiving webhooks" guide says "verify the signature first" without being able to show how, and `examples/order-webhook` falls back to a shared bearer token. Outbound, `Http.Credential` never sees the body, so an application cannot sign the webhooks it sends.
- **Sign-in throttling per client.** `Protection.PasswordThrottle` limits guessing of one account. Its docs leave limiting per client address to "the server's rate limit on the route", which does not exist. Nothing stops one address from trying API keys, session ids or passwords against many accounts.

## Solution

### 1. `one-time` — single-use tokens (new module, `metadata.name: OneTime`)

**Token sets.** A set is a `Telo.Provider` with its own durable `name`, a `store` (`KvStore.Store`), a required `ttl` (`Telo.Duration`) and an optional `dataType` (a `Telo.JsonSchema` reference, `x-telo-serializable`) for what each token carries. It comes in two kinds under the abstract `OneTime.TokenSet`:
- `OneTime.Links` — a random secret sent in a URL. `bytes` defaults to 32 and is at least 16. The token is base64url.
- `OneTime.Codes` — a short code a person types. `digits` defaults to 6 (6–10). `maxAttempts` defaults to 5.

**Operations.** Each names its set through a reference slot, so pairing an operation with the wrong kind of set is `REFERENCE_KIND_MISMATCH` before the app runs.
- `OneTime.Issue` (either kind of set): `{ subject, data?, binding? }` → `{ token, expiresAt }`.
  - `subject` names who or what the token is for: an email, a user id, an invitation.
  - **A set holds at most one live token per subject.** Issuing again replaces the previous token, so "resend the code" invalidates the old one.
  - `data` is held to the set's `dataType`.
  - `binding` is a value the redeemer must present again, such as a cookie set in the browser that asked.
  - `token` is sensitive.
- `OneTime.Redeem` (on `Links`): `{ token, binding? }`.
- `OneTime.RedeemCode` (on `Codes`): `{ subject, code, binding? }`.
- `OneTime.Revoke`: `{ subject }` → `{ revoked }`.

**What a redemption answers.** Success is `{ redeemed: true, subject, data }`, with `data` typed from the set's `dataType`. Otherwise it is `{ redeemed: false, reason }`, where `reason` is one of:
- `unknown` — never issued, already used, replaced, revoked or expired; these are not told apart;
- `binding_mismatch` — the token is **not** consumed, so it can still be opened in the right browser;
- `mismatch` — a wrong code, which uses up one attempt;
- `exhausted` — the attempt that used up the last one; the code is then deleted.

A refused redemption is an outcome the page renders, never a throw.

**Storage.**
- Only the SHA-256 of a link token is stored, as `<name>/t/<digest>`, beside a subject pointer `<name>/u/<sha256(subject)>`. A dump of the store yields no usable link.
- A code is stored per subject as `<name>/c/<sha256(subject)>`, digested together with the subject. Six digits can be guessed offline from a dump while the code lives, which is why a code set's `ttl` should be minutes.
- Redemption is one `compareAndDelete`, so a token works exactly once across every replica sharing the store.
- A wrong code is one `compareAndSet`. A write that keeps losing the race is `ERR_ONE_TIME_CONTENDED`.
- A store that throws is `ERR_ONE_TIME_STORE_UNAVAILABLE`, with the thrown value as `cause`; a cancellation passes through. This is the same guard `session` has.
- Two sets claiming one `name` on one store are `ONE_TIME_NAME_DUPLICATE`, a resource rule with `coReferrers: /store`, twinned by `ERR_ONE_TIME_NAME_DUPLICATE`.

**Dependencies:** `one-time` → `kv-store`. It imports no transport and no identity module. Rate-limiting how often tokens are issued is the route's job (`RateLimit.Guard`).

### 2. Signed requests

**The presentation (`auth`).** `Auth.Presentation` gains a fifth variant, `Auth.SignaturePresentation`. Its `type` is `signature`, and it has these members:
- `base` — the exact bytes that were signed (`Telo.Bytes`);
- `signatures` — the signatures presented, as a list of bytes, since Stripe sends several during a secret rotation;
- `keyId`, `algorithm`, `nonce` — each nullable;
- `created`, `expires` — nullable `Telo.Timestamp`s.

`base` and `signatures` are `x-telo-sensitive`. The transport builds `base`, so the verifier never sees a request.

**Reading the body before authentication (`http-server`).**
- A credential source may publish `coversBody: true` in its reading. On a mount or route whose `authentication:` lists such a source, the server reads the body (up to `maxBodyBytes`) before running the verifiers, after the throttle check (part 3).
- The handler receives that same body. A route that declares a streamed body gets a stream over the buffered bytes, so nothing is refused.
- The cost is stated in the docs: an unauthenticated caller can make the server buffer up to `maxBodyBytes`, so a webhook route should set a small `maxBodyBytes`.

**Two credential sources (`http-server`, under `Http.CredentialSource`).** Both are generic. Vendor schemes are documented recipes, not kinds.
- `Http.FromMessageSignature { label?, components }` reads RFC 9421 `Signature-Input` / `Signature`.
  - **Which signature it reads:** the one named `label`. Without a label, the request must carry exactly one signature, otherwise it is malformed.
  - **Required coverage:** the signature must cover every entry of `components`. These are derived components (`@method`, `@target-uri`, `@authority`, `@scheme`, `@request-target`, `@path`, `@query`, `@query-param;name=…`) and header fields. A signature covering less is malformed.
  - **Base and members:** it builds the signature base of RFC 9421 §2.5, with `@target-uri` as the server already derives it for DPoP. It takes `keyId`, `alg`, `created`, `expires` and `nonce` from the signature parameters.
  - **Body:** when `content-digest` is covered, it checks `Content-Digest` (RFC 9530, `sha-256` / `sha-512`) against the body, and a mismatch is refused 401.
  - **Not supported:** the `;sf`, `;bs`, `;key` and `;req` component parameters are not supported in this plan; a signature using them is malformed.
  - It publishes `coversBody: true` only when `components` names `content-digest`.
- `Http.FromBodySignature` reads the webhook family.
  - `signature: { header, pattern?, encoding }` — `pattern` is an RE2 pattern (`format: re2-pattern`, checked by `telo check`) whose first group captures each signature, all matches taken. Without one, the whole header is the signature. `encoding` is `hex | base64 | base64url`.
  - `timestamp: { header, pattern?, unit: seconds | milliseconds }`, optional.
  - `nonce: { header }`, optional.
  - `algorithm`, default `hmac-sha256`.
  - `base`, an ordered list of parts joined with nothing between them: `{ text }`, `{ header, pattern? }`, or `body`.
  - It always publishes `coversBody: true`.

A missing signature header is "no credential" for both sources. A present but unreadable one throws `ERR_HTTP_CREDENTIAL_MALFORMED`. Feeding either source to a verifier that cannot take a signature presentation is the existing `CONTRACT_INPUTS_MISMATCH`.

**The verifier — `auth-signature` (new module, `metadata.name: AuthSignature`).** `AuthSignature.Verifier` extends `Auth.Verifier` and takes `signature` presentations only.
- **`keys`** is a list of `{ id?, subject, secret | jwk }`. `secret` is a sensitive string decoded as `encoding` (`utf8` by default, or `base64` / `base64url` / `hex`). `jwk` is a public key.
  - A presentation with a `keyId` is checked against the key with that `id`.
  - One without a `keyId` is checked against every key that has no `id`, which covers secret rotation.
- **`algorithms`** is required and drawn from the RFC 9421 registry: `hmac-sha256`, `ed25519`, `ecdsa-p256-sha256`, `ecdsa-p384-sha384`, `rsa-pss-sha512`, `rsa-v1_5-sha256`.
- **Freshness:**
  - `maxAge` defaults to 5 minutes and `clockSkew` to 30 seconds.
  - `timestamp: required` is the default, so a presentation with no `created` is refused. `optional` admits providers that send no timestamp (GitHub, Shopify).
  - A passed `expires` is refused.
- **`replay`** takes an optional `KvStore.Store`. It remembers the nonce, or the digest of the signature when there is none, for `maxAge + clockSkew`, and refuses a second presentation.
- **Principal:** an accepted signature yields `kind: service` with `subject` from the matching key.
- **Refusals** are `unknown_key`, `algorithm_not_allowed`, `bad_signature`, `stale`, `untimed` and `replayed`. Each comes with a null challenge, and the verifier publishes `challenges: []` and no `issuer`.
- **Comparisons:** every comparison is constant-time.
- **Failures:** a replay store that throws is `ERR_AUTH_SIGNATURE_STORE_UNAVAILABLE`, which the server answers 503.

**Dependencies:** `auth-signature` → `auth`, `kv-store`. It imports no transport.

**Outbound twin (`http-client`).**
- The input of `Http.Credential` gains `request.body` (`Telo.Bytes`, nullable). The client fills it only for a credential whose reading publishes `coversBody: true`.
- A streamed body sent through such a credential is refused at the call with `ERR_HTTP_CREDENTIAL_BODY_STREAMED`.
- Existing credentials publish nothing new and are unchanged.
- Two new credential kinds sit beside `Http.BearerToken` and the others:
  - `Http.MessageSignature { key: { id, secret | jwk }, algorithm, components, label, expiresIn?, nonce }` writes `Content-Digest` when `content-digest` is covered, then `Signature-Input` and `Signature`. `label` defaults to `sig1`, and `created` is always stated.
  - `Http.BodySignature { secret, encoding, algorithm, base, timestamp?, header: { name, value } }` uses the same parts as the inbound source. The `{ header }` parts read headers the caller already set, such as `webhook-id`. `header.value` is `!interpolate` over the bindings `signature` and `timestamp` (`t=${{ timestamp }},v1=${{ signature }}`). `timestamp.header`, when given, is written too.

### 3. Throttling sign-in per client (`http-server`)

`authentication:` gains `throttle: { budget, key? }`.
- `budget` is a `RateLimit.Budget`, whose `limit` and `window` say how many refused credentials are allowed per window.
- `key` is evaluated per request over `request` and defaults to `request.ip`.
- A route's `authentication.throttle` overrides the mount's key by key, as every other `authentication` key does.

**Per request:**
1. **Before anything else** — before the body is read and before any verifier runs — the server reserves 1 under the key.
2. **A spent budget** is answered 429 with `Retry-After` from the budget, code `ERR_HTTP_AUTHENTICATION_THROTTLED`, `data: { retryAfter }`. No verifier runs, so a throttled client costs no password hash and no store read.
3. **After authentication:** an accepted credential, an anonymous request and a verifier that throws settle the reservation to 0. A refused or malformed credential leaves it spent.

The code is raised into the route, router and server `catches:` lists through `x-telo-catches-for`, beside the four existing refusals, and has a built-in problem body. This throttle covers every verifier on every `Telo.Mount`. `Protection.PasswordThrottle` stays the per-account half, and its docs now point here instead of at a rate limit that did not exist.

**Dependencies:** `http-server` → `rate-limit` (new edge; `rate-limit` imports only `cache`).

## Decisions

- **Single-use tokens are their own module, not a `kv-store` kind.** `kv-store` stays a storage contract with no protocol, as with `KeyedClaim`. Tokens carry their own vocabulary: subject, binding, attempts.
- **Links and codes are two kinds.** They redeem with different inputs (a code needs its subject, a link does not), so the wrong pairing is a reference-kind error rather than a rule.
- **One live token per subject.** Replacement on reissue is what makes "resend" safe. A caller wanting independent tokens uses distinct subjects.
- **A signature presentation carries the signed bytes, not the request.** This keeps the verifier transport-neutral, as for every other presentation. The HTTP sources own the RFC 9421 base and the webhook formats.
- **One generic body-signature source instead of a kind per vendor.** The parts list and RE2 patterns cover Stripe, GitHub, Slack, Shopify and Standard Webhooks as data. A vendor kind in `http-server` would name vendors in a generic module.
- **The body is read before authentication only where a source needs it.** Every other mount keeps authenticating before the body arrives.
- **Throttling lives on the mount, counting refusals, not requests.** A request limit punishes legitimate traffic. A per-verifier wrapper would have to be repeated on each verifier and cannot see the client address, which a transport-neutral verifier is never given.

## Bookkeeping

- **Docs:**
  - `modules/one-time/docs/` and `modules/auth-signature/docs/`, each with a README;
  - `http-server` `authentication.md` (the two sources, body-before-authentication, `throttle`);
  - `http-client` credential docs;
  - `auth` `presentations.md` (the fifth variant);
  - `protection` `password-throttle.md` (pointing at `throttle`);
  - `queue` `receiving-webhooks.md`, whose "verify the signature first" gains the recipe;
  - recipes for Stripe, GitHub, Slack, Shopify and Standard Webhooks in `auth-signature`'s docs.
- **Example:** `examples/order-webhook` switches from its bearer token to `Http.FromBodySignature` plus `AuthSignature.Verifier`, with its tests updated.
- **Primer and guides:** the primer (`apps/authoring-agent/chat/primer.md`), the hub `design-library` guide and `modules/CLAUDE.md` describe the three building blocks.
- **Ledger entries** in `docs/guides/what-you-get.md`, under Standard library, auth: single-use links and codes, verifying and signing webhooks and HTTP message signatures, and sign-in throttling per client. The "Request authentication with a typed caller" entry gains the signature sources.
- **Release:** one `Added` fragment per module: `one-time`, `auth-signature`, `auth`, `http-server`, `http-client`, `protection`. No changeset, since no published npm package changes.
- **Floors:** the new vocabulary is added to each module's own kinds, so no module needs a floor for exposing it. Only a manifest writing new syntax that an older analyzer refuses declares one, verified by running the previous CLI against it.
- **Roadmap:** the identity roadmap drops the token mechanics from `passwordless`, `auth-signature` from phase 6 and per-IP lockout from `protection`.

## Verify

- **Single-use tokens**, on two applications sharing one `kv-store-sql` store over SQLite:
  - a link redeemed on one is `unknown` on the other;
  - two concurrent redemptions of one link give exactly one `redeemed: true`;
  - reissuing for a subject makes the first token `unknown`;
  - a bound link redeemed without its binding answers `binding_mismatch`, and still redeems afterwards with it;
  - a code answers `mismatch` four times, then `exhausted`, then `unknown`, even for the right code;
  - an expired token is `unknown`;
  - the store's rows contain neither the link token nor the code;
  - `Issue` with `data` violating `dataType` is refused by `telo check`, and so is `OneTime.RedeemCode` naming a `OneTime.Links`;
  - two sets with one `name` on one store are `ONE_TIME_NAME_DUPLICATE`, and running without checking fails with `ERR_ONE_TIME_NAME_DUPLICATE`.
- **Signed requests:**
  - published test deliveries from Stripe, GitHub, Slack, Shopify and Standard Webhooks verify through `Http.FromBodySignature` recipes;
  - one changed body byte is a 401;
  - a timestamp six minutes old is a 401 (`stale`), and so is a GitHub-style signature when `timestamp` is left `required`;
  - with `replay` set, a repeated delivery is refused on a second replica sharing the store;
  - the RFC 9421 Appendix B vectors for `hmac-sha256` and `ed25519` verify through `Http.FromMessageSignature`;
  - a `Content-Digest` that does not match the body is a 401;
  - a request signed by `Http.MessageSignature`, and a webhook signed by `Http.BodySignature`, verify against the matching inbound verifier;
  - a streamed body sent through either credential is `ERR_HTTP_CREDENTIAL_BODY_STREAMED`;
  - `telo check` refuses `Http.FromBodySignature` feeding `AuthBearer.Jwt` (`CONTRACT_INPUTS_MISMATCH`) and an invalid RE2 `pattern`;
  - a handler behind a body-signature source receives the parsed body, the same bytes that were verified.
- **Throttling:**
  - with a budget of 5 per minute, the sixth wrong API key from one address is a 429 with `Retry-After`, and the verifier is not called (its store sees no read);
  - another address still gets 401 for a wrong key and 200 for a right one;
  - successful requests from the throttled address before its limit spend nothing;
  - an unreachable verifier store is 503 and spends nothing;
  - the 429 is catchable in a route's `catches:`.

## Example after the change

```yaml
kind: OneTime.Links
metadata: { name: passwordResets }
name: password-reset
store: !ref kv
ttl: 30m
dataType: !ref ResetData
---
kind: AuthSignature.Verifier
metadata: { name: stripeSignatures }
algorithms: [hmac-sha256]
keys:
  - { subject: stripe, secret: !cel "secrets.stripeWebhookSecret" }
replay: !ref kv
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
mounts:
  - path: /webhooks
    mount: !ref webhooks
    authentication:
      throttle: { budget: !ref authFailures }
      verifiers:
        - verifier: !ref stripeSignatures
          from:
            kind: Http.FromBodySignature
            signature: { header: Stripe-Signature, pattern: "(?:^|,)v1=([0-9a-f]+)", encoding: hex }
            timestamp: { header: Stripe-Signature, pattern: "(?:^|,)t=(\\d+)", unit: seconds }
            base:
              - { header: Stripe-Signature, pattern: "(?:^|,)t=(\\d+)" }
              - { text: . }
              - body
```
