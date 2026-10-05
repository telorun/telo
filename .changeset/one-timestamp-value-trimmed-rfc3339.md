---
"@telorun/cel": minor
---

**The branded CEL timestamp is Telo's one timestamp value, and a `Date` is never a Telo value.** An instant is `{ seconds, nanos }` in `0001-01-01T00:00:00Z … 9999-12-31T23:59:59.999999999Z`, asked with `isCelTimestamp` and built with `celTimestamp(seconds, nanos)` or the new `celTimestampFromMillis(ms)` — the mirror of `celDurationFromNanos` for a host clock reading. A `Date` is a foreign host object: it is refused at a `Telo.Timestamp` slot, at `telo check` and at creation alike (the stand-in the analyzer substitutes is built from the same binding the kernel asserts with), and a typed frame refuses one at its path, naming the factory to use. A writer producing text for a reader outside the value domain — a log line, a chart label — may still hold one.

**One timestamp text, everywhere: RFC 3339 in UTC with a `Z` and a trimmed fraction.** Absent when the instant is whole, otherwise one to nine digits with no trailing zero — CEL's own `string(timestamp)`, which is now the authority for the `rfc3339` plain encoding, the `google.protobuf.Timestamp` frame payload, the plain JSON writer, a log record, an `!interpolate` hole and a manifest literal. So `2026-01-15T07:30:00Z` rather than `…00.000Z`, and `…00.000000001Z` is representable where the millisecond floor made it unwritable. A tenth fractional digit is refused rather than rounded, in both directions.

**The millisecond floor is gone from the spec, not just from the code.** `kernel/specs/durable-execution.md` §6.3 stated it and gave Node's host `Date` as its reason in the same breath; the timestamp payload is now the duration's rule, and §6.6's vectors carry a nanosecond instant as a value.

Two pins that name the frame's payload grammar move with it: the recorded-value codec version is `2`, and version `1` is still READ under its own grammar (exactly three fractional digits) so a run parked before this change resumes rather than being stranded; the controller-protocol generation is `telo-5` (`4` is withdrawn, having named the millisecond payload and never been spoken by any carrier). The emitter's format generation is untouched — no emitted text changes.

The Rust half lands with it: `kernel/rust` / `sdk/rust` carry the nanosecond `Timestamp` and the same canonical text, over the one shared vector file both halves read.
