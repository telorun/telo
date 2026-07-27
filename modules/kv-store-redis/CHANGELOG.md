# Changelog
## 0.2.0 - 2026-07-27
### Added
* Initial release. putIfAbsent is SET NX PX; the two compare-and-* operations are generic Lua scripts that compare a revision and know nothing about the value, so every consumer reuses them. No fallback store — a conditional write served from a second, unsynchronised store would let two callers both believe they won. Requires `maxmemory-policy noeviction`.## 0.1.0
