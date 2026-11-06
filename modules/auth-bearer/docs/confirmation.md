# Sender-constrained tokens

A token can be bound to its holder, so a stolen copy is useless. The binding is a `cnf` claim; the proof comes from the transport as the verifier's `confirmation` input.

**A `cnf` on a token is always enforced.** Configuration only adds what is needed to check a proof and what to demand.

## DPoP (RFC 9449)

A token with `cnf.jkt` is bound to the key whose RFC 7638 SHA-256 thumbprint that is. It needs `confirmation.dpop`:

| Key | Meaning |
| --- | --- |
| `replay` | Required. A `KvStore.Store`. It must not evict, so it is never a cache. |
| `algorithms` | Required. The signature algorithms a proof may use. Published in the challenge as `algs`. |
| `maxProofAge` | How far a proof's `iat` may be from now, either way; 60s when omitted. |
| `required` | Refuse every token that is not DPoP-bound. |

The transport supplies `confirmation.dpop` as `{ proof, method, uri }`: the `DPoP` header, the request's HTTP method and its absolute URI without query or fragment. The proof is accepted when:

- its header has `typ: dpop+jwt`, an `alg` from `algorithms` and the public key as `jwk` (never a private or symmetric one), and the signature verifies under it;
- `htm` equals `method` and `htu` equals `uri` (scheme and host normalized, query and fragment ignored);
- `iat` is within `maxProofAge`;
- `ath` equals the base64url SHA-256 of the access token;
- the key's thumbprint equals `cnf.jkt`;
- its `jti` has not been used: it is recorded with `putIfAbsent` and a time to live of twice `maxProofAge`. The store is shared by every replica pointing at it, so a proof replayed at another replica is refused.

The proof is recorded last, after every other check passed, so a refused token does not consume it. Verifiers sharing a `replay` store share the record.

A DPoP-bound token at a verifier with no `confirmation.dpop` is refused (`confirmationMismatch`), since its binding cannot be checked. The challenge scheme is `DPoP` when `dpop.required` is set or the token is DPoP-bound.

## Certificate-bound tokens (RFC 8705)

A token with `cnf.x5t#S256` must arrive over the connection whose client certificate has that thumbprint. The transport supplies `confirmation.certificateThumbprint`: **the base64url encoding, without padding, of the SHA-256 digest of the certificate's DER encoding**. A missing or different value is `confirmationMismatch`. `certificateBound: true` refuses every token that carries no `cnf.x5t#S256`.
