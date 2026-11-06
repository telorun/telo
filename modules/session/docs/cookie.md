# The session cookie

The cookie is declared once, as an `HttpDispatch.HostCookie` (a `__Host-` cookie: `Secure`, `Path=/`, no `Domain`, `HttpOnly`, `SameSite=Lax`), and referenced three ways:

- the mount's `Http.FromCookie { cookie: !ref sessionCookie }` reads the token from it;
- the login route's `cookies:` entry sets it;
- the logout route's `cookies:` entry clears it with `maxAge: 0s`.

`Session` itself names no cookie, so the name, scope and attributes stay the application's.

## Remember me

`cookies:` takes `expires`. Pass `result.cookieExpiresAt` from `Session.Start`: for a session started with `persistent: true` it is the absolute deadline and the cookie is sent with an `Expires`, so it survives a browser restart; otherwise it is null and **a null `expires` writes no `Expires` or `Max-Age` at all**, so the browser drops the cookie when it closes.

## Cross-site requests

A request authenticated through `Http.FromCookie` that changes state must come from this site: `Sec-Fetch-Site` of `same-origin` or `none`, or an `Origin` that is the mount's or listed in the source's `trustedOrigins`; otherwise it is refused 403. The same request carrying the session as a bearer token (`Http.FromAuthorization` into the same verifier) is not checked, since a browser never sends one on its own. Nothing in this module is needed for that: see [the origin check](../../http-server/docs/authentication.md#the-origin-check).
