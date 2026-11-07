# Cookie declarations

A cookie's name, scope and protections are a **declaration** — a resource of one of
three kinds extending the abstract `HttpDispatch.Cookie` — and a response entry's
`cookies:` names it. Everything the declaration says is fixed when it is created, so
every response that sets or clears the cookie sends the same attributes. How a
server sets, clears and reads cookies is in
[`modules/http-server/docs/cookies.md`](https://hub.telo.run/module/oci/ghcr.io/telorun/http-server/).

## The kinds

| Kind | Name on the wire | `Secure` | `Domain` | `Path` |
| --- | --- | --- | --- | --- |
| `HostCookie` | `__Host-<name>` | always | never | always `/` |
| `SecureCookie` | `__Secure-<name>` | always | `domain`, optional | `path`, default `/` |
| `UnprefixedCookie` | `<name>` | `secure`, default `true` | `domain`, optional | `path`, default `/` |

Every kind takes `name` (required), `httpOnly` (default `true`), `sameSite`
(`Strict` | `Lax` | `None`, default `Lax`) and `partitioned` (default `false`).
All fields are compile-eval, like every provider's: literals, `variables` and
`secrets`, never the request.

## The rules

Every rule is plain JSON Schema on the kind, so `telo check` and the kernel refuse
the same declaration as `SCHEMA_VIOLATION`:

- `name` is an RFC 6265 token and does not begin `__Host-` or `__Secure-` in any
  letter case — the kind renders the prefix, and browsers match it
  case-insensitively.
- A `HostCookie` declares no `domain` and no `path`, so its scope is the one a
  browser accepts a `__Host-` cookie with.
- An `UnprefixedCookie` with `sameSite: None` or `partitioned: true` must not set
  `secure: false`.
- `domain` and `path` are cookie attribute values — printable ASCII without `;`,
  the shared named shape `HttpDispatch.CookieAttributeValue` — and `path` starts
  with `/`.

A computed field is held to the same rules once it is evaluated: a `domain` whose
variable holds `a.test; Path=/x` is refused when the declaration is created
(`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`), before any response is written.

## The published record

Each kind's controller publishes the normalized attributes as its reading, so
`resources.<name>` reads them in CEL and a transport renders `Set-Cookie` from the
record alone:

| Member | Meaning |
| --- | --- |
| `name` | The name as sent, prefix included (`__Host-session`). |
| `secure`, `httpOnly`, `partitioned` | Booleans, defaults filled. |
| `sameSite` | `Strict`, `Lax` or `None`. |
| `domain` | The domain, or `null` for a host-only cookie. |
| `path` | The path. |

A cookie kind written elsewhere extends `HttpDispatch.Cookie` and publishes the same
record; the dispatcher never asks which kind declared a cookie.
