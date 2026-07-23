---
"@telorun/templating": minor
---

Add `sum(list): double` and `avg(list): dyn` CEL reducers (siblings of `min` / `max`), so a list of numbers can be folded in any CEL expression. `sum` returns 0 for an empty list; `avg` returns null for one (hence the `dyn` return, like `min` / `max`, so null-safety applies). These back the new `std/collection` module's aggregation kinds, and are usable in any manifest CEL.
