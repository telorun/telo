# Changelog

## 0.2.2 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.2.0 - 2026-11-06
### Added
* New module: Protection.PasswordThrottle, an Auth.PasswordVerifier that counts failed attempts per identifier on a RateLimit.Budget and answers throttled, without calling the wrapped checker, once the budget is spent. A success settles its reservation to nothing.
