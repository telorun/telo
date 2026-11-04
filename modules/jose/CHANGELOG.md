# Changelog

## 0.2.0 - 2026-11-04
### Added
* New module: JWT signing and verification with ES256, RS256, EdDSA or HS256 key sets — managed sets kept as one record in a key/value store with private keys wrapped under an HKDF-derived key and rotation that converges across replicas, or static sets from secrets; remote key sets by JWKS URL or issuer discovery; a published JWKS; verification that returns why a token was refused; and sealed values (JWE dir + A256GCM) with secret rotation.
