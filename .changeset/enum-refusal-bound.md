---
"@telorun/analyzer": patch
---

A value outside a large enum is refused in one line: past 20 allowed values the message gives their count and the nearest ones instead of the whole list (`/name must be one of 1943 allowed values; did you mean 'house'?`), the same in `telo check` and at runtime. A union whose alternatives include such an enum describes it by count too. An enum of 20 values or fewer reads as before.
