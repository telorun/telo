# AuthBasic.Verifier

Extends `Auth.Verifier`. It takes `passwords`, an `Auth.PasswordVerifier`, and `realm`, printable ASCII without `"` or `\`.

## Reading a credential

1. It accepts only `basic` presentations, which `Http.FromBasic` builds from `Authorization: Basic …`. Any other variant is refused as `malformed`. Credentials that do not decode never reach the verifier: `Http.FromBasic` refuses them as malformed itself.
2. It hands `{ identifier, password }` to `passwords` and returns the principal it answers, with `via` set to this verifier's name.
3. A refusal from `passwords` is returned as a refusal.

## Answers

A refusal is returned, never thrown: `{ refused: true, reason, challenge }`, `reason` one of `malformed`, `unknown`, `mismatch`, `disabled` or `throttled`. **Every refusal carries the same challenge**, `Basic realm="<realm>", charset="UTF-8"`, so a client that was refused is asked for credentials again whatever the cause. The reason is for logs and operators; the client sees the same 401 for an unknown user, a wrong password, a disabled account and a throttled identifier.

The verifier publishes `challenges: [{ scheme: Basic, parameters: { realm, charset: "UTF-8" } }]` from its own `realm`, so a request with no credentials is challenged the same way. It declares no `issuer`, which `Auth.Verifier` reserves for an authorization server whose tokens a verifier accepts.

A password checker that fails (a hasher given a hash in an unknown format) is a thrown error, not a refusal.

## Why not Digest

HTTP Digest authentication (RFC 7616) is deliberately not offered, and is not planned. The server must hold something equivalent to the password (a hash of `user:realm:password`) to recompute the response, so a leaked store lets an attacker authenticate without cracking anything, and it rules out the salted, slow password hashes `Crypto.PasswordHash` writes. Basic over TLS with a slow hash is the stronger arrangement.

## Over TLS only

Basic sends the password with every request. Serve it only over TLS, and put per-client-address throttling at the transport; `Protection.PasswordThrottle` bounds guessing per identifier.
