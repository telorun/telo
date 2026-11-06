# Changelog

## 0.2.0 - 2026-11-06
### Added
* New module: Identity.DeclaredUsers, an Auth.PasswordVerifier over users written in the manifest with password hashes from secrets, checked through Crypto.PasswordHash. An unknown identifier is verified against a dummy hash so it takes as long as a wrong password.
