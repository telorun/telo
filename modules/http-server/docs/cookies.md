# Cookies

A cookie is **declared once** — its name, its scope and the protections a browser
enforces — and a response **lists** the declarations it sets or clears. Only the
value and the lifetime vary per response, so a cookie set by one route and cleared by
another is always sent with the same scope, and the browser actually drops it.

## Declaring a cookie

The kinds come from `http-dispatch`, the transport-neutral carrier every HTTP
transport shares, so an application imports it beside `http-server`:

```yaml
imports:
  Http: oci://ghcr.io/telorun/http-server@<version>
  HttpDispatch: oci://ghcr.io/telorun/http-dispatch@<version>
---
kind: HttpDispatch.HostCookie
metadata: { name: session }
name: session
```

Pick the kind by the scope the cookie needs:

| Kind | Sent as | Scope |
| --- | --- | --- |
| `HttpDispatch.HostCookie` | `__Host-<name>`, always `Secure` | `Path=/` on exactly the host that set it, no `Domain` |
| `HttpDispatch.SecureCookie` | `__Secure-<name>`, always `Secure` | optional `domain`, `path` (default `/`) |
| `HttpDispatch.UnprefixedCookie` | `<name>` | optional `domain`, `path` (default `/`), `secure` (default `true`) |

`HostCookie` is the right choice for a session: a browser refuses a `__Host-` cookie
that names a domain or any path but `/`, and refuses either prefix from an insecure
origin, so the prefix is a guarantee another subdomain cannot overwrite.
`UnprefixedCookie` is for a name an existing client or protocol dictates.

Every kind also takes:

| Field | Default | Renders |
| --- | --- | --- |
| `name` | required | an RFC 6265 token, never spelling `__Host-` or `__Secure-` (in any case) — the kind adds the prefix |
| `httpOnly` | `true` | `HttpOnly`; a cookie page scripts must read says `httpOnly: false` |
| `sameSite` | `Lax` | `SameSite=Strict` / `Lax` / `None` |
| `partitioned` | `false` | `Partitioned` (CHIPS) |

A declaration is a provider: every field is fixed when it is created, from literals,
`variables` or `secrets` — never from the request.

### What is refused before the app runs

Each of these is a `SCHEMA_VIOLATION`, from `telo check` and from the kernel alike:

- a `HostCookie` with `domain` or `path`;
- an `UnprefixedCookie` with `sameSite: None` or `partitioned: true` and
  `secure: false` — a browser drops both;
- a `name` that is not a token (`a;b`, `a b`), or one beginning `__Host-` /
  `__Secure-` in any case (`__host-x`) — browsers match the prefixes
  case-insensitively, so the spelling would promise a guarantee the kind does not
  give;
- a `domain` or `path` holding `;` or a control character, and a `path` not
  starting with `/`.

An attribute reading `request` is `CEL_UNKNOWN_IDENTIFIER`: nothing about a request
exists when a declaration is created. A computed attribute is held to the same rules
once evaluated, and one that breaks them is refused when the declaration is created
(`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`).

## Setting and clearing a cookie

A `returns:` or `catches:` entry lists its cookies under `cookies:`, each
`{ cookie, value?, maxAge?, expires? }`:

```yaml
returns:
  - status: 204
    cookies:
      - cookie: !ref session
        value: !cel "result.sessionId"
        maxAge: 86400s
```

- `cookie` — the declaration, by `!ref`, or inline when only one entry writes it.
- `value` — RFC 6265 cookie-octets, optionally in double quotes; omitted, empty.
  A literal outside that is refused by `telo check`; a computed one fails the
  response with `ERR_COOKIE_VALUE_INVALID`, naming the cookie, the way a body that
  fails its `schema` does. Nothing is escaped silently: a value carrying arbitrary
  text is encoded first, for example with base64url.
- `maxAge` — a `Telo.Duration`, sent as whole seconds.
- `expires` — a `Telo.Timestamp`, sent as an HTTP date.

Each cookie is one `Set-Cookie` header line, in the order listed; the same
declaration listed twice is written twice, in that order. Every line carries the
declaration's whole scope:

```
__Host-session=abc123; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax
```

**Clearing is `maxAge: 0s`** (or any max age of zero or less) on the same
declaration: the value is empty unless one is given, `Max-Age=0`, and `Expires` in
the past unless one is given — under the declaration's own `Domain`, `Path` and
`Secure`, byte for byte, which is what makes a browser drop it:

```yaml
cookies: [{ cookie: !ref session, maxAge: 0s }]
```

```
__Host-session=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax
```

**`Set-Cookie` in `headers:` is refused**, at entry level and per MIME type — a raw
string would bypass the checked shape. `Content-Type` is refused the same way, since
the matched `content` key is its only source. `telo check` reports either
(`DEPENDENT_SCHEMA_MISMATCH`), and an `Http.Api` route declaring one is refused at
creation.

An entry with `cookies:` documents a `Set-Cookie` response header for its status in
the OpenAPI document.

## Reading cookies

Every `request` context carries `request.cookies` beside `request.headers` — route
`inputs:`, `returns:` and `catches:`, the scope-level `catches:`, a guard's
`inputs:` and `catches:`, the not-found handler and `preferredLanguages`. It is the
`Cookie` header read per RFC 6265: each `name=value` pair split at its first `=`, a
pair without `=` skipped, **the first occurrence of a name kept**, and each value
passed through as written, quotes included, with no decoding. A prefixed cookie is
read by its full name: `request.cookies['__Host-session']`.

A route that declares no cookies reads `request.cookies` as a map of string to
string. Declaring `request.schema.cookies` types `request.cookies.<name>`,
validates the cookies and documents each as an `in: cookie` parameter:

```yaml
request:
  path: /me
  method: GET
  schema:
    cookies:
      type: object
      required: [theme]
      properties: { theme: { type: string, enum: [light, dark] } }
```

Cookies are text by transport, so they are read into the type their schema declares,
as a query is. A refused cookie is answered `400` with the `ERR_INPUT_INVALID`
problem, its finding pointing at `/cookies/<name>`.

When `preferredLanguages` reads `request.cookies`, `Cookie` joins the response's
`Vary` — see [request language](request-language.md#reading-a-language-cookie).
