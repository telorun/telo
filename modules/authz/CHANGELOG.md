# Changelog

## 0.2.0 - 2026-11-06
### Added
* New module: authorization policies with ordered CEL rules over the caller, action, resource and context; the first matching rule decides, an unmatched action is denied, and a denial can name the scopes the caller lacks.
