# Changelog

## 0.2.1 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.2.0 - 2026-11-06
### Added
* New module: Identity.DeclaredUsers, an Auth.PasswordVerifier over users written in the manifest with password hashes from secrets, checked through Crypto.PasswordHash. An unknown identifier is verified against a dummy hash so it takes as long as a wrong password.
