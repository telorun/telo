# Changelog
## 0.2.0 - 2026-07-27
### Added
* Update controller @telorun/kv-store to 0.2.0.
* Initial release. The KvStore.Store abstract is a durable, non-evicting key/value store with atomic conditional writes (get / putIfAbsent / compareAndSet / compareAndDelete); a null return is contention, not failure. It differs from Cache.Store by GUARANTEE, not operations. The claim/renew/settle/release protocol is deliberately NOT in the abstract — it lives once in KeyedClaim over those primitives, so no backend reimplements the ownership guard.## 0.1.0
