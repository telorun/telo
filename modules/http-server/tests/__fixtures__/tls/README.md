# TLS test fixtures

Every file here is TEST MATERIAL: the private keys are public by being in this
repository, and nothing outside the tests may trust these certificates.

| File | What it is |
| --- | --- |
| `ca.pem` | `CN=Telo Test CA`, self-signed; signs `server.pem` and `client.pem`. |
| `server.pem`, `server.key` | `CN=localhost`, SAN `DNS:localhost`, `IP:127.0.0.1`, server authentication. |
| `client.pem`, `client.key` | `CN=telo-client`, SAN `DNS:telo-client`, client authentication. |
| `other-ca.pem` | `CN=Other Test CA`, self-signed; signs `rogue-client.pem`. |
| `rogue-client.pem`, `rogue-client.key` | `CN=rogue`, SAN `DNS:rogue`, client authentication, signed by a CA no test server trusts. |

All are RSA 2048 with SHA-256, valid from 30 October 2026 for 36,500 days (until
6 October 2126), so no test fails on an expired fixture. Tests assert the
client certificate's serial number, fingerprint and validity, so regenerating
`client.pem` means updating those assertions.

Generated with OpenSSL; a certificate signed by a CA (here `client`, by `ca`):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=Telo Test CA" \
  -addext "basicConstraints=critical,CA:TRUE" -keyout ca.key -out ca.pem
openssl req -newkey rsa:2048 -nodes -subj "/CN=telo-client" -keyout client.key -out client.csr
openssl x509 -req -in client.csr -CA ca.pem -CAkey ca.key -days 36500 -out client.pem \
  -extfile <(printf "subjectAltName=DNS:telo-client\nextendedKeyUsage=clientAuth\nbasicConstraints=CA:FALSE")
```

`server` takes `subjectAltName=DNS:localhost,IP:127.0.0.1` and
`extendedKeyUsage=serverAuth`; `other-ca` and `rogue-client` repeat the first
two steps under their own names. The CA keys are not kept.
