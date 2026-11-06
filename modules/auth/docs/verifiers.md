# Verifiers

`Auth.Verifier` is the contract a transport calls to turn a presented credential into a caller.

**Input** `{ presentation, confirmation, resource }`

- `presentation` — an `Auth.Presentation`, narrowed by the concrete verifier (see [presentations](./presentations.md)).
- `confirmation` — what the transport can prove about who holds the credential: `certificateThumbprint` (the SHA-256 thumbprint of the TLS client certificate) and `dpop` (`proof`, plus the request's `method` and absolute target `uri`). Either is absent when the request had none. A verifier that binds tokens to a key (RFC 8705, RFC 9449) compares them; the rest ignore it.
- `resource` — the canonical URI of the protected resource, or `null` on a transport with none. A verifier that checks an audience (RFC 8707) compares it.

**Output** (`Auth.VerifierOutput`) is one of

- `{ principal }` — an [`Auth.Principal`](./principal.md).
- `{ refused: true, reason, challenge }` — `reason` is for logs and operators and is never shown to the caller; `challenge` is `{ scheme, parameters }`, the `WWW-Authenticate` challenge this verifier contributes, or `null`.

## Refusal or throw

A credential that is wrong, expired, revoked or unknown is **a refusal, returned as output**. A verifier that cannot reach what it needs to judge — a key source, an introspection endpoint, a store — **throws**, so the transport can answer "unavailable" instead of "unauthorized". A refusal never means the infrastructure failed, and a throw never means the caller is wrong.

What a transport shows for a throw is its own answer, never the verifier's code: `Http.Server` answers any coded throw from a verifier with `503` and the problem code `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` (`data: { stage: verifier }`). The verifier's own code stays in the trace and the log, as the cause.

## Issuers

A verifier's published reading (its `snapshot()`, readable as `resources.<name>`) carries `issuer`, when the kind declares one: the authorization server whose tokens it accepts, as configured (an `Auth.Issuer`, an http or https URL). The key `issuer` is reserved for exactly that meaning. A transport reads it to derive protected-resource metadata (RFC 9728 `authorization_servers`), so an issuer is written once, on the verifier. A verifier with no issuer — a password check, a trusted header, an opaque API key — declares none and publishes none; such a resource is still valid, since `authorization_servers` is optional.

## Challenges

The reading also carries `challenges`: the `WWW-Authenticate` challenges, `{ scheme, parameters }`, this verifier asks for a credential with when a request presents none. A transport takes the scheme from where it looks for the credential and the parameters from here: for each scheme its credential source answers, the verifier's challenge of that scheme (matched case-insensitively), else the bare scheme. A verifier with nothing to add publishes an empty list. A refusal's own `challenge` replaces this one for the request it refuses.

## Implementing one

Extend `Auth.Verifier` in a module that imports `auth`, give the kind its own `inputType` narrowing `presentation`, return the shapes above, and put `challenges` (and `issuer`, if it declares one, typed from `Auth.Issuer`) in the snapshot. `outputType` is inherited. Always set every `Auth.Principal` member, and `via` to the resource's name.

The sibling contracts follow the same rules: `Auth.PasswordVerifier` takes `{ identifier, password }` and refuses with `unknown`, `mismatch`, `disabled` or `throttled`; `Auth.Policy` takes `{ principal (null when anonymous), action, resource, context }` and answers `{ allow, reason?, requiredScopes? }`, where `requiredScopes` lets a transport answer RFC 6750 `insufficient_scope`. A policy that throws is answered as a verifier that throws is: `Http.Server` shows only `503` `ERR_HTTP_ACCESS_CHECK_UNAVAILABLE` (`data: { stage: policy }`).
