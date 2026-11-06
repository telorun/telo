# Stateless sessions

A session that needs no server-side state, and so cannot be listed or ended before it expires, is not a kind of this module. Sign a JWT at login, put it in the same kind of cookie, and verify it with `AuthBearer.Jwt`:

```yaml
- request: { path: /login, method: POST }
  handler:
    kind: Jose.Sign
    keys: !ref keys
    type: at+jwt
    issuer: https://login.example
    audience: https://app.example/app
  inputs: { subject: !cel "request.body.subject", expiresIn: 1800s }
  returns:
    - status: 204
      cookies: [{ cookie: !ref sessionCookie, value: !cel "result.token" }]
---
kind: AuthBearer.Jwt
metadata: { name: sessionJwt }
keys: !ref keys
issuer: https://login.example
algorithms: [ES256]
audience: !cel "[resource]"
```

and mount it with `from: { kind: Http.FromCookie, cookie: !ref sessionCookie, scheme: Session }`. This works because `Http.FromCookie` and `Http.FromAuthorization` both present a `token`, and a verifier takes a token from wherever it was found. The cookie is held to the same origin check as any session cookie.

A stateless session lives until its `exp`; it cannot be ended, listed or capped. Choose [`Session.Sessions`](./sessions.md) when a user must be able to log out everywhere.
