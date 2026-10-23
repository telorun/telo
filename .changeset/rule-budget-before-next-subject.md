---
"@telorun/analyzer": patch
---

A resource or referrer rule is reported as over its evaluation budget only when a subject is left unjudged: the budget is checked before the next evaluation, so one slow evaluation of the last subject (a cold first call on a loaded machine) no longer reports a rule that checked everything as stopped.
