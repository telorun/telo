# Serving HTTPS

`tls` on an `Http.Server` makes it speak HTTPS, optionally with mutual TLS.
Omitted, the server speaks plain HTTP — leave it unset behind a TLS-terminating
proxy, and read the certificate the proxy forwards with
[`forwardedClientCertificate`](#a-certificate-forwarded-by-a-proxy).

| Field | Meaning |
| --- | --- |
| `cert`, `key` | Server certificate chain and its private key (required). |
| `passphrase` | Passphrase of an encrypted `key`. |
| `minVersion` | `TLSv1.2` (default) or `TLSv1.3`: the oldest protocol version negotiated. |
| `clientCa` | CA bundles that sign accepted client certificates. |
| `clientCertificate` | `none` (default) does not ask for a certificate. `required` closes a connection without one signed by `clientCa`. `optional` asks, and completes the handshake whether the client presents none, one `clientCa` signed, or one it did not — the request reads which. `optional` and `required` need `clientCa`; `clientCa` needs one of them. |

`cert`, `key` and each `clientCa` item are `{ pem: <text> }` or
`{ file: <path> }` (a `Telo.HostPath`), exactly one. Material is read and
cross-checked when the server is created — unparseable PEM, an unreadable file,
a key that does not match the certificate, inconsistent `clientCa` /
`clientCertificate` — and the TLS checks fail with `ERR_HTTP_TLS_INVALID` without key text. A general schema violation elsewhere in the resource is reported by the kernel's validator, which prints the value it rejected: keep the key in a secret or a file rather than a literal.

With `tls` set, the `Listening` record carries `url.scheme: https`.

## Connections and handshakes

The server accepts every connection on a socket it owns — a TCP listener, or a
TLS listener when `tls` is set — and hands each one to the HTTP layer only once
its TLS handshake has completed. So a request's TLS session and client
certificate are read from the socket the server itself handshook, the same way
on every host.

- **Handshake timeout.** A handshake not complete within 120 seconds is
  abandoned and its connection closed. It belongs to the listener; request and
  keep-alive timeouts belong to the HTTP layer and apply once a connection is
  handed on.
- **Failed handshakes are logged.** A TLS connection closed before it is served —
  a handshake error, the timeout, the client hanging up mid-handshake, or under
  `clientCertificate: required` a certificate `clientCa` did not sign or none at
  all — is logged as `http.server.tls_handshake.failed` with the peer's address
  and the reason (see [Log events](log-events.md)). Under `required` the
  certificate is judged once the handshake completes, so a refused client sees
  its connection closed rather than a TLS alert.
- **Stopping.** When the server stops it accepts no new connection, closes every
  idle connection and every one still in its handshake at once, ends each busy
  connection after its response (which carries `Connection: close`), and has
  stopped once all of them are closed. The app's close hooks run while it waits,
  so a mount ending its long-lived responses (an event stream) on close lets the
  stop finish.

## What a handler reads

Every `request` CEL context — a route's `inputs:`, `returns:` and `catches:`,
a router's and the server's `catches:`, a mount `guard`, the not-found handler
and `preferredLanguages` — carries two members:

- **`request.tls`** — `{ protocol }` (`TLSv1.2`, `TLSv1.3`) for a request on a
  TLS socket, `null` on a plain one. It describes this server's socket only:
  behind a terminating proxy it is `null` even though the client spoke HTTPS.
- **`request.clientCertificate`** — `null`, or the client's certificate:

  | Member | Value |
  | --- | --- |
  | `subject`, `issuer` | Map of attribute to value (`CN`, `O`, `OU`, …); a repeated attribute's values are joined with `, `. |
  | `serialNumber` | Uppercase hexadecimal. |
  | `fingerprint256` | SHA-256 of the DER bytes, colon-separated uppercase hexadecimal. |
  | `validFrom`, `validTo` | `Telo.Timestamp`s. |
  | `subjectAltNames` | List of `<type>:<value>` entries: `DNS:api.example`, `IP Address:10.0.0.1`, `URI:spiffe://…`, `email:…`. |
  | `pem` | The certificate as PEM. |
  | `verified` | `true` only when this listener validated the chain against `clientCa`. |
  | `via` | `listener` — presented to this server — or `proxy` — forwarded by a fronting proxy. |

  Both members are nullable, so an expression guards them:
  `request.clientCertificate != null && request.clientCertificate.verified`.

Under `required` every request carries a verified certificate. Under `optional`
a request carries `null` when the client presented none, and the certificate
with `verified: false` when `clientCa` did not sign it — deciding what an
unverified certificate may do is the handler's, or a guard's.

The certificate is a member of `request` rather than of `request.tls` because
behind a terminating proxy there is a certificate and no TLS socket: a consumer
reads one place whichever way it arrived.

Both members are read from the socket the server's own listener accepted, so
they read the same on every host the controller runs on.

## A certificate forwarded by a proxy

A proxy that terminates TLS can pass the client's certificate on in a header.
`forwardedClientCertificate` names the header and its format:

```yaml
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
trustProxy: true
forwardedClientCertificate: { header: x-forwarded-client-cert, format: xfcc }
mounts: [{ path: /, mount: !ref api }]
```

| `format` | Proxy | The header holds |
| --- | --- | --- |
| `xfcc` | Envoy (`x-forwarded-client-cert`) | Elements separated by `,`, one per proxy; the **last** — written by the proxy in front of this server — is read, and its `Cert` key (URL-escaped PEM, configured with `set_current_client_cert_details: { cert: true }`). |
| `pem` | nginx (`$ssl_client_escaped_cert`) | The URL-escaped PEM. |
| `base64-der` | Traefik (`X-Forwarded-Tls-Client-Cert`) | Base64 DER, optionally URL-escaped; of a comma-separated chain the first, the client's own. |

A forwarded certificate is `verified: false, via: proxy`: this server checked
nothing about its chain. A header that does not parse yields `null` and the
request is served; the server logs `http.server.forwarded_certificate.unreadable`
at `warn` (see [Log events](log-events.md)). When the listener verified a
certificate of its own, that certificate wins over a forwarded one.

**It needs `trustProxy`.** Without a trusted proxy any client could send the
header itself, so declaring `forwardedClientCertificate` on a server that
trusts none — no `trustProxy`, `trustProxy: false` or `0` — is refused by
`telo check` (`HTTP_FORWARDED_CERTIFICATE_UNTRUSTED`) and at creation
(`ERR_HTTP_FORWARDED_CERTIFICATE_UNTRUSTED`). The proxy must also strip the
header from what clients send, which is the proxy's own configuration.
