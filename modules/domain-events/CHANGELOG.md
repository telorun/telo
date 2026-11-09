# Changelog

## 0.2.1 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.2.0 - 2026-11-08
### Added
* New module: business events a library announces and its importers handle inside the announcing call and its transaction — Domain.Event, Domain.Emit and Domain.Handler.
