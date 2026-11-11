---
"@telorun/cel": minor
---

The calendar functions read a year from 1 to 99 as itself. `addMonths`, `startOfMonth`, `isoIn` and `nowIso` used to read such a year as 1900 to 1999 when they turned a wall clock back into an instant or wrote a zone's offset, so `addMonths(timestamp('0050-01-31T00:00:00Z'), 1)` now answers `0050-02-28T00:00:00Z`, and a result that falls before year 1 is refused with `addMonths: the result is outside the range of a timestamp` instead of answering an instant in the 1900s.
