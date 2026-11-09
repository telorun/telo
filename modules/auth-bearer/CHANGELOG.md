# Changelog

## 0.2.1 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.2.0 - 2026-11-06
### Added
* `AuthBearer.Jwt` and `AuthBearer.Introspection` publish `challenges` in their readings: `Bearer`, plus `DPoP` with `algs` when DPoP proofs are verified, for a transport answering a request that presented no token.
* issuer moves up to AuthBearer.AccessTokenVerifier, required and typed from Auth.Issuer, and AuthBearer.Jwt and AuthBearer.Introspection publish it as issuer in their readings for protected-resource metadata.
* New module: verifies OAuth 2.0 access tokens for an API. AuthBearer.Jwt checks signed JWT access tokens against an issuer's keys and AuthBearer.Introspection asks the issuer's introspection endpoint, both enforcing audience, issuer, expiry and type, optional revocation with AuthBearer.Revoke, and DPoP or client-certificate bound tokens, and answering with the caller's principal or a refusal with its challenge.
