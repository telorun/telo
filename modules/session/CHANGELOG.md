# Changelog

## 0.2.4 - 2026-11-11
### Fixed
* The restriction's lower bound named telo 0.130.0, which was never published; it now names 0.131.0, the first published release at or above it.

## 0.2.3 - 2026-11-09
### Fixed
* The restriction's lower bound named telo 0.130.0, which was never published; it now names 0.131.0, the first published release at or above it.

## 0.2.2 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.2.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.2.0 - 2026-11-06
### Added
* New module: server-side login sessions over a durable key/value store. Session.Sessions holds a set of sessions with idle and absolute lifetimes, remembered-session lifetimes and a per-user cap; Session.Start, Rotate, End, EndAll and List start a session under a fresh id, replace it when privileges change, and end one session or every session of a user in a single write. Session.Verifier authenticates a session token read from a cookie, refusing ended and expired sessions, and slides the idle deadline with at most about ten writes per idle period. A failing store is ERR_SESSION_STORE_UNAVAILABLE and rotating a session the user does not hold is ERR_SESSION_NOT_FOUND.
* Two session sets claiming one `name` on one store are refused: `SESSION_NAME_DUPLICATE` at `telo check` on each set, and `ERR_SESSION_NAME_DUPLICATE` (`data: { name }`, naming both sets) when the second is created. Their records would otherwise collide, and each set's tokens would be accepted by the other's verifier. The module now requires telo 0.130.0 or later.
