# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.2 - 2026-10-05
### Fixed
* A CEL duration and uint are read through the value domain's own predicates (isCelDuration, isCelUint) rather than by class, so a value built by any copy of the engine is recognised: identity is a string type key under Symbol.for("telo.cel.value"), not a constructor.
* A duration-valued field is read again: a duration is identified by a type key and carries no methods, so these controllers read one through durationNanos and build one with celDurationFromNanos instead of naming a class the CEL value domain no longer has — which failed at resource creation with 'isCelDuration is not defined', a missing 'Duration' export, or 'value.getMilliseconds is not a function'.

## 0.2.1 - 2026-10-04
### Fixed
* A CEL duration and uint are read through the value domain's own predicates (isCelDuration, isCelUint) rather than by class, so a value built by any copy of the engine is recognised: identity is a string type key under Symbol.for("telo.cel.value"), not a constructor.
* A duration-valued field is read again: a duration is identified by a type key and carries no methods, so these controllers read one through durationNanos and build one with celDurationFromNanos instead of naming a class the CEL value domain no longer has — which failed at resource creation with 'isCelDuration is not defined', a missing 'Duration' export, or 'value.getMilliseconds is not a function'.

## 0.2.0 - 2026-10-03
### Added
* New module. Watch.Wait holds a call until a topic's version passes the caller's cursor, returning { changed, version }: at once when the version is already past it, within milliseconds of a publish, or with changed false at the call's timeout, capped by the resource's maxTimeout. Any number of waiters share a topic, a timed-out cursor can be waited on again, and a cancelled call releases its waiter and rethrows the cancellation. Watch.Publish raises a topic's version monotonically and wakes every waiter below it. Watch.Store is the store contract and Watch.MemoryStore the in-process backend. A wait inside a durable region is refused by telo check (ZONE_ATTRIBUTE_VIOLATED) and at runtime (ERR_WATCH_REPLAY_FORBIDDEN).
