# Crypto

Cryptographic building blocks for manifests: random tokens, digests, HMAC, password hashing, constant-time comparison and HKDF key derivation. Every kind is one operation and a `Telo.Invocable`; text inputs are their UTF-8 bytes, and bytes (`Telo.Bytes`) are accepted wherever text is. Secrets — passwords, keys, tokens, hashes — are marked sensitive and kept out of trace payloads and the debug wire.

## Kinds

| Kind | Inputs → outputs |
| --- | --- |
| `Crypto.Random` | `{ bytes (32), encoding: hex \| base64url \| base64 }` → `{ value }` |
| `Crypto.Digest` | `{ algorithm: sha256 \| sha384 \| sha512, input, encoding (hex) }` → `{ value }` |
| `Crypto.Hmac` | `{ op: sign \| verify, algorithm, key, input, encoding (hex), expected? }` → `{ value }` or `{ valid }`. Verification is constant-time; an `expected` that will not decode is `valid: false`. |
| `Crypto.PasswordHash` | `{ op: hash \| verify, password, hash? }` → `{ hash }` or `{ valid, rehash }`. See [password hashing](./docs/password-hashing.md). |
| `Crypto.Compare` | `{ a, b }` → `{ equal }`, in constant time and blind to length. CEL's `==` is not constant-time. |
| `Crypto.DeriveKey` | `{ secret, salt?, info?, length (32), hash (sha256), encoding (base64url) }` → `{ key }`, by HKDF (RFC 5869). |

```yaml
imports:
  Crypto: oci://ghcr.io/telorun/crypto@<version>
---
kind: Telo.Sequence
metadata: { name: sign }
steps:
  - name: signature
    invoke: { kind: Crypto.Hmac }
    inputs: { op: sign, key: !cel "secrets.webhookKey", input: !cel "variables.payload" }
```

## Errors

- `ERR_CRYPTO_UNSUPPORTED_HASH` — `verify` was given a stored hash in an encoding the module does not know.
- `ERR_PASSWORD_TOO_LONG` — a bcrypt password over 72 bytes.

## Code library

`exports.code` declares `@telorun/crypto`: the same operations as functions (`randomValue`, `digest`, `hmacSign`, `hmacVerify`, `constantTimeEqual`, `deriveKey`, `hashPassword`, `verifyPassword`, plus the `toBytes` / `encodeBytes` / `decodeBytes` helpers), for a sibling module's controller to call in-process. Import the module and name `@telorun/crypto` from the controller.
