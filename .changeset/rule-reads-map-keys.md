---
"@telorun/templating": patch
"@telorun/analyzer": patch
---

A resource or referrer rule that iterates a map or tests membership with `in` reads only the map's keys, so it is judged on a resource whose map values are `!cel` instead of being reported as `RESOURCE_RULE_SKIPPED`; over a list the elements are still read.
