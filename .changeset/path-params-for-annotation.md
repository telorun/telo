---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

A new schema annotation, `x-telo-path-params-for: { template, through? }`, relates a map of path variables to the path template beside it — a literal template, a `!ref` read through the named field of the declaration it names, or an expression, which is never expanded. `telo check` refuses a template whose braces are not whole segments of distinct names (`PATH_TEMPLATE_INVALID`), a variable no entry binds, an omitted map included (`PATH_PARAMETER_UNBOUND`), an entry naming no variable (`PATH_PARAMETER_UNUSED`) and a malformed or misplaced annotation (`PATH_PARAMS_FOR_INVALID`); the kernel raises each `ERR_`-prefixed from the same reader when it creates the resource or registers the kind.
