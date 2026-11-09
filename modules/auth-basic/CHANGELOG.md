# Changelog

## 0.2.1 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.2.0 - 2026-11-06
### Added
* New module: AuthBasic.Verifier, an HTTP Basic verifier that hands the identifier and password from Http.FromBasic to any Auth.PasswordVerifier. Every refusal carries the Basic realm challenge with charset UTF-8, the reason stays out of the response, and Digest authentication is deliberately not offered.
