# Changelog

## 0.2.1 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.2.0 - 2026-11-04
### Added
* New module: random tokens, SHA-2 digests, HMAC, password hashing (argon2id, bcrypt, scrypt, PBKDF2) with pepper and rehash-on-login, constant-time comparison and HKDF key derivation, plus an @telorun/crypto code library.
