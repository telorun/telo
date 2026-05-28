---
"@telorun/analyzer": patch
---

Fail loud instead of silently accepting manifests the analyzer can't fully process. A `Telo.Definition` whose schema AJV cannot compile (e.g. an unresolvable local `$ref`) previously had its compile error swallowed, silently skipping schema validation for every resource of that kind — it is now reported once as `SCHEMA_COMPILE_ERROR` on the definition. An expression tagged with an unregistered templating engine (`!foo`) was silently left unanalyzed and is now reported as `UNKNOWN_ENGINE`.
