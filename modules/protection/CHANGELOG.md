# Changelog

## 0.2.0 - 2026-11-06
### Added
* New module: Protection.PasswordThrottle, an Auth.PasswordVerifier that counts failed attempts per identifier on a RateLimit.Budget and answers throttled, without calling the wrapped checker, once the budget is spent. A success settles its reservation to nothing.
