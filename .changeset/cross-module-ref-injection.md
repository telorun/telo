---
"@telorun/analyzer": patch
---

Fix Phase-5 reference injection for resources inside an imported library. `expandedFieldMapForResource` resolved a resource's own kind through the global alias scope, so a library-internal resource whose kind uses a library-local import alias (e.g. `Ai.AgentStream` in a library that imports `Ai`) produced no ref-field map — and its references (a model, tool providers, …) were silently left uninjected, surfacing at runtime as `'model' is not a live instance` (ERR_INVALID_REFERENCE). The kind is now resolved through the resource's own module alias scope, so imported-library resources get their refs injected like root resources do.
