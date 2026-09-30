---
"@telorun/analyzer": patch
---

A step body whose steps produce no result (only `if:` / `while:` / `switch:` / `throw:`) now has an empty `steps` map and, where the resource is invocable or runnable, `inputs` in CEL scope typed from the input contract, instead of reporting every read as `CEL_UNKNOWN_IDENTIFIER`.

`inputs` in an Application's boot targets (a target's `when:` or an inline target's `inputs:`) is now `CEL_UNKNOWN_IDENTIFIER` in every Application. Where the Application had a named inline invoke target it used to pass `telo check` and fail at run with `Unknown variable: inputs`.
