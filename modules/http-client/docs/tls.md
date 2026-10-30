# TLS settings on `Http.Client`

`tls` on an `Http.Client` applies to every request made through that client —
streamed bodies, retries and the credential re-authentication retry included. It
belongs to the client alone: two clients in one application can trust different
CAs and present different certificates, and nothing process-wide changes. A client
with no `tls` behaves exactly as before.

| Field | Meaning |
| --- | --- |
| `ca` | List of CA bundles that sign the server's certificate. |
| `caMode` | `replace` (default) trusts only `ca`; `add` trusts the system roots as well. |
| `cert`, `key` | Client certificate chain and private key for mutual TLS. Set together; the key must match the certificate. |
| `passphrase` | Passphrase of an encrypted `key`. |
| `serverName` | Name used for SNI and for checking the certificate's host name instead of the URL's host. |
| `insecureSkipVerify` | Accept any server certificate. Dangerous: for local development only. A warning is logged each time the client starts with it set. |

`ca` items, `cert` and `key` are each `{ pem: <text> }` or `{ file: <path> }`,
exactly one. `pem` takes plain PEM text, from a secret or a `!include-text`; a
base64-wrapped value (as in a kubeconfig's `*-data` fields) is decoded first with
`base64Decode(...)` in CEL. `file` is a `Telo.HostPath`: an absolute path on the
host, such as `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`, or
`!module-path` for a file that ships with the module.

## Failures

Material is read and cross-checked when the client starts: unparseable PEM, an
unreadable file, a key that does not match its certificate, a missing passphrase
all fail the client with `ERR_HTTP_TLS_INVALID`, and the TLS checks carry no key text. A general schema violation elsewhere in the resource is reported by the kernel's validator, which prints the value it rejected: keep the key in a secret or a file rather than a literal.
A server certificate that is not trusted, or whose name does not match, fails the
request with the TLS cause in the message (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
`ERR_TLS_CERT_ALTNAME_INVALID`); a server that requires a client certificate and
gets none, or an untrusted one, closes the connection (`UND_ERR_SOCKET`). Nothing
falls back to the defaults.

The key is not part of the client's published state (`resources.<name>`).

## Deriving a kind

A kind that `extends: Http.Client` sets the block through `base:` from its own
fields:

```yaml
kind: Telo.Definition
metadata: { name: ClusterClient }
extends: Http.Client
schema:
  type: object
  required: [server, caPem, clientCertPem, clientKeyPem]
  properties:
    server: { type: string }
    caPem: { type: string }
    clientCertPem: { type: string }
    clientKeyPem: { type: string }
base:
  baseUrl: !cel "self.server"
  tls:
    ca: [{ pem: !cel "self.caPem" }]
    cert: { pem: !cel "self.clientCertPem" }
    key: { pem: !cel "self.clientKeyPem" }
```

A complete example is in `tests/__fixtures__/tls-client/`.
