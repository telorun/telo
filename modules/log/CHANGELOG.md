# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-28
### Added
* New module. Log.Emit writes one structured log record per call — a level (trace to fatal), a message and typed attributes — through the application's logging pipeline, so the record carries its resource and import scope and the caller's trace ids, and the scope's threshold, redaction and every configured sink apply. The module exports a ready-made instance, Log.emit. telo check refuses a level outside the six names and an input key the contract does not declare.
