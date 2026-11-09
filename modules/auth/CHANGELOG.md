# Changelog

## 0.2.1 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor: the lowest published telo that reads this module.

## 0.2.0 - 2026-11-06
### Added
* A verifier's reading now publishes `challenges`, the WWW-Authenticate challenges it asks for a credential with when a request presents none; `Auth.TrustedHeader` publishes an empty list. The verifier and policy docs state that a transport answers a thrown failure with its own code.
* Auth.Issuer names the authorization server a verifier trusts, and Auth.Verifier reserves the key issuer for it: a verifier declaring one publishes it in its reading as configured, which a transport advertises in protected-resource metadata. Auth.TrustedHeader's recorded issuer is now principalIssuer.
* New module: the shared vocabulary of inbound authentication — the authenticated principal, credential presentations (token, basic, certificate, asserted), verifier, password-verifier and policy contracts — and a verifier for identities asserted by a trusted reverse proxy.
