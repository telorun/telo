# Changelog
## 0.2.0 - 2026-07-27
### Added
* Initial release. In-process backend whose conditional writes are atomic within the single-threaded event loop, so the guarantees hold for ONE process — development and tests only. Overflowing `maxEntries` raises ERR_STORE_FULL as an InvokeError (catchable from a manifest) rather than evicting, since dropping a record would break the non-eviction guarantee.## 0.1.0
