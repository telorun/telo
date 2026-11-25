# Changelog

## 0.2.0 - 2026-11-24
### Added
* New module AuthSignature with AuthSignature.Verifier: verifies HMAC-SHA-256 and Ed25519 signatures over signed bytes against keys that each state their algorithm, with secret rotation, maxSignatureAge and clockTolerance freshness, and expiry. Replay is left to the receiver's idempotency.
