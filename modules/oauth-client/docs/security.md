# Security

What this module verifies and enforces, and what it leaves to you.

## PKCE is on by default

Proof Key for Code Exchange binds an authorization code to the program that
requested it. Without it, a code intercepted on the way back — from a shell
history, a proxy log, another application registered for the same redirect URI — is
enough to obtain tokens. With it, the code is useless without a secret that never
left the process.

`S256` is the default. `plain` exists for servers that genuinely cannot do the
hash; `none` disables the protection and should be a considered decision, not a
default someone inherited.

## The issuer is verified, not just carried

`iss` is checked in three places: the authorization response (RFC 9207), on both
the browser-served `Callback` and the terminal `TokenExchange`; and the discovery
document, whose declared `issuer` must match what the resource declares. This is
the defence against mix-up attacks, where an attacker who controls one
authorization server persuades a client to redeem a code at another.

When the discovery document advertises
`authorization_response_iss_parameter_supported`, a response arriving **without**
`iss` is refused — `reason: issuer_missing` — rather than treated as nothing to
check. A missing `iss` from a server that says it sends one is exactly what the
attack produces, so skipping the check there would remove the defence precisely
when it is needed.

For the terminal flow this means wiring the redirect's `iss` into the exchange:

```yaml
- name: tokens
  invoke: !ref Exchange
  inputs:
    code: !cel "steps.redirect.result.code"
    iss: !cel "steps.redirect.result.iss"
```

A mismatch in a callback is reported as `reason: issuer_mismatch` rather than
thrown — it is an outcome the page has to render — but no grant is stored. In
`TokenExchange`, which has no page to render, it raises.

A server configured with explicit endpoints instead of discovery cannot advertise
anything, so `iss` is verified there when present but cannot be made mandatory.

Declaring `issuer` as its own resource is what made this expressible: an issuer
that lives as an optional string on whichever client happened to be used cannot be
checked.

## A pending sign-in is single-use

`Authorization` writes a record keyed by the one-time `state`, holding the PKCE
verifier, the redirect URI and the grant key. `Callback` consumes it with a
compare-and-delete, so a replayed callback finds nothing and is refused as
`unknown_state`.

The verifier is never sent to the browser. Carrying it in a signed cookie or
encoded into `state` would put a secret in the user agent and make it impossible to
revoke a pending flow.

Records expire after `pendingTtl` (default 10 minutes) — long enough to read a
consent screen, short enough that an abandoned attempt does not linger.

## Only one refresh per grant at a time

See [Grants and storage](grants.md#refresh). A concurrent refresh against a
rotating provider can look like refresh-token replay, which providers answer by
revoking the entire grant.

## Secrets

The client secret is bound through `secrets:` like any other credential:

```yaml
secrets:
  clientSecret: { env: OAUTH_CLIENT_SECRET, type: string }
```

Public clients — a CLI, a native app, a single-page application — have no secret at
all and rely on PKCE. Set `tokenEndpointAuthMethod: none` for them.

Tokens are stored verbatim. Encryption at rest is the store's concern, not this
module's: a store that encrypts serves every consumer, and one that re-implements
it per caller serves none of them well. Tokens are never logged.

## Loopback, not localhost

The listener binds `127.0.0.1` explicitly rather than resolving `localhost`, which
can resolve to an interface other than loopback, and only ever binds loopback —
this module never opens a socket reachable from the network.

## Why the outbound calls do not go through `http-client`

Discovery, the token endpoint and the device endpoint use the platform `fetch`
directly, behind a shared deadline helper, even though this module imports
`http-client` for the `Http.Credential` abstract. That is a deliberate stop, not an
oversight, and it is the weakest part of the module's design.

The pull the other way is real: routing through `Http.Request` would bring
timeouts, retry policy, redirect handling, proxying and trace events for free
instead of re-expressing the first of them here — `AuthorizationServer.timeout` is
a private re-invention of `Http.Client.timeout`, and today a consumer behind a
proxy or one who wants a retry on a flaky token endpoint has no way to ask for it.

What stopped it is that the honest version is a `client:` slot on
`AuthorizationServer` defaulting to a plain client when omitted, and that is a
package-boundary decision with a trap next to it: the client used for the token
endpoint must **not** carry a credential, or refreshing a token requires a token.
The cycle is avoided by simply not attaching one — but "simply" is doing work
there, and it deserves an explicit decision rather than being introduced as a
refactor.

**So: do not "fix" this by wiring a credentialed `Http.Client` into the token
endpoint.** If you add the slot, default it to an unauthenticated client and say so
in the field description.

## What is not covered yet

- **Token revocation** (RFC 7009). `GrantClear` forgets a grant locally; it does
  not tell the server to invalidate it.
- **Introspection** (RFC 7662).
- **Anything to do with the ID token.** `id_token` is stored verbatim when the
  server returns one and is otherwise untouched — its signature is not verified,
  and none of its claims (`iss`, `aud`, `exp`, `nonce`) are read or checked. It is
  an opaque string this module carries for you. Do not treat a stored `idToken` as
  proof of identity without validating it yourself.
- **mTLS or private-key-JWT client authentication.** `client_secret_basic`,
  `client_secret_post` and `none` are supported.
