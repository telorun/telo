/**
 * The CEL value domain, re-exported: what a `duration` and a `uint` ARE, and how a value
 * says so.
 *
 * **Identity is a string type key under `Symbol.for("telo.cel.value")`, never a
 * constructor.** That is the whole reason this file is one line of re-export rather than a
 * realm guard. The engine this replaced typed and dispatched by class, so a `Duration` built
 * by one copy of it was not a duration to another — `+`, `type()` and every overload would
 * reject it — and the SDK existed as the single scope every package and controller obtained
 * the classes from, with a startup probe asserting that the engine's copy and the SDK's were
 * one. A symbol from the global registry is the same symbol in both, so two independently
 * loaded copies of `@telorun/cel` agree about a value without anything being deduplicated,
 * and the probe has nothing left to check.
 *
 * **`isCelRecord` is the companion every structural WALK needs.** A branded value is a
 * plain object, so a walk that decided "is this a container to descend into?" by testing
 * the prototype now descends into a duration or a uint and rebuilds it without its brand —
 * where a class instance was returned untouched. `isCelRecord` is that question asked of the
 * value domain instead: a plain-prototype object carrying no type key.
 *
 * A controller therefore BUILDS a value with `celUint` / `celDurationFromNanos` and ASKS
 * with `isCelUint` / `isCelDuration`; `new` and `instanceof` are gone, and the fields are
 * the ones they were (`.value`, `.seconds`, `.nanos`). There is one duration constructor and
 * it takes total nanoseconds, so a duration outside CEL's range cannot be built at all — it
 * answers the range error instead. A timestamp carries its own key for the same reason a
 * duration does: nanosecond precision no host date type holds.
 *
 * **A map is here for the same reason a duration is.** A CEL map whose keys are not all
 * strings has no faithful plain form, so it carries the key `map` and holds its entries by
 * each key's own typed value — `isCelMap` is how a host reader recognises one, and
 * `celMapFromEntries` is the only way a controller can BUILD one (a `Map` with `bigint`
 * keys was that value under the engine this replaced, and is now an ordinary host object
 * the typed frame refuses). What identifies an entry stays the engine's business: a reader
 * walks `entries.values()` for the `{ key, value }` pairs.
 */
export {
  celDurationFromNanos,
  celMapFromEntries,
  celMapKeys,
  celTimestamp,
  celTimestampFromMillis,
  celUint,
  durationNanos,
  durationNanosFromText,
  formatDuration,
  formatTimestamp,
  isCelDuration,
  isCelMap,
  isCelRecord,
  isCelTimestamp,
  isCelUint,
  parseDuration,
  parseTimestamp,
  timestampNanos,
} from "@telorun/cel";
export type {
  CelDuration,
  CelMap,
  CelMapKey,
  CelTimestamp,
  CelUint,
  CelValue,
} from "@telorun/cel";
