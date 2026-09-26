---
"@telorun/analyzer": minor
---

Removed: `AnalysisOptions.teloVersion` and `ValidateRequiresOptions.teloVersion`. An analysis always checks `requires: telo:` against the surface generation the analyzer itself implements (`TELO_SURFACE_VERSION`); editing against another telo version means running that version's own engine (`@telorun/language-server`). `manifestCompatibility` still takes the version to check a candidate against.
