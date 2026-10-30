# Serving HTTPS

`tls` on an `Http.Server` makes it speak HTTPS, optionally with mutual TLS.
Omitted, the server speaks plain HTTP — leave it unset behind a TLS-terminating
proxy.

| Field | Meaning |
| --- | --- |
| `cert`, `key` | Server certificate chain and its private key (required). |
| `passphrase` | Passphrase of an encrypted `key`. |
| `clientCa` | CA bundles that sign accepted client certificates. |
| `clientCertificate` | `none` (default) or `required`, which closes a connection without a certificate signed by `clientCa`. `required` needs `clientCa`, and `clientCa` needs `required`. |

`cert`, `key` and each `clientCa` item are `{ pem: <text> }` or
`{ file: <path> }` (a `Telo.HostPath`), exactly one. Material is read and
cross-checked when the server is created — unparseable PEM, an unreadable file,
a key that does not match the certificate, inconsistent `clientCa` /
`clientCertificate` — and the TLS checks fail with `ERR_HTTP_TLS_INVALID` without key text. A general schema violation elsewhere in the resource is reported by the kernel's validator, which prints the value it rejected: keep the key in a secret or a file rather than a literal.

With `tls` set, the `Listening` record carries `url.scheme: https`.
