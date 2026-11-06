# Request language

Every request has a language, chosen by the server from the languages the application serves: its own `lang:` plus the `lang` of every catalog in its `translations:` block. It is `request.lang`, a language tag that is always present, in every request context the server and its routers declare: a route's `inputs`, `returns` and `catches`, router and server `catches`, mount guards (`inputs`, `catches`) and the not-found handler. It is negotiated once per request, before the guard.

## Order of preference

1. The tags `Http.Server.preferredLanguages` returns, in order.
2. `Accept-Language`, by quality (`q=`). `*`, a zero quality and a malformed entry are skipped.
3. The application's own language.

Each candidate is matched against the served languages by RFC 4647 lookup (`pl-PL` finds `pl`). A malformed or unserved tag is skipped, never refused.

`preferredLanguages` is an optional CEL expression evaluated per request over `request` (`headers`, `cookies`, `query`, `path`, `host`, `method`, `ip`, `tls`, `clientCertificate` — no `lang`), returning a list of strings. Any other result, or a list holding a non-string entry, is refused with `ERR_PREFERRED_LANGUAGES_INVALID` (the request is answered 500):

```yaml
kind: Http.Server
metadata: { name: server }
listen: { port: 8080 }
preferredLanguages: !cel "'lang' in request.query ? [request.query.lang] : []"
mounts: [{ mount: !ref api }]
```

## Content-Language and Vary

When more than one language is served, a response whose production read the language carries `Content-Language: <lang>` and `Vary: Accept-Language`. The language is read when an expression evaluated for the response (`inputs`, `returns`, `catches`, a guard's) reads `request.lang`, or when a problem's `detail` is shown in it. A response that never reads it carries neither header.

`Vary` also lists every header `preferredLanguages` reads — any read of `request.cookies` (or `request.headers.cookie`) adds `Cookie`; a computed header name makes it `Vary: *`. Reading the query or the path adds nothing. An existing `Vary` is merged.

## Reading a language cookie

A language the user chose is usually kept in a cookie. `request.cookies` holds the request's cookies by name (the first of a repeated name, each value as sent — see [cookies](cookies.md#reading-cookies)):

```yaml
preferredLanguages: !cel "'lang' in request.cookies ? [request.cookies.lang] : []"
```

A response negotiated this way carries `Vary: Accept-Language, Cookie`. The cookie itself is set by a route that lists an `HttpDispatch.UnprefixedCookie` (or `HostCookie`, read back as `request.cookies['__Host-lang']`) in its `cookies:`.

An application serving one language gets `request.lang` equal to its own language and never sends either header.

## Problem details

A problem's `detail` — and `error.displayMessage` in a `catches:` entry — is the failure's display message translated through the application's catalogs into `request.lang`, then formatted with the error's data.

## Notes

- `request.lang` is not enumerable on the `request` object: it is read by name (`request.lang`), and it reaches a handler only when its `inputs:` map names it (`inputs: { lang: !cel "request.lang" }`).
- A mount registered by another module reads the language from its request scope: `requestScope.forRequest(request).lang` (see `@telorun/http-dispatch`). Reading it is what makes the response vary by it.
