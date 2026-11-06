---
"@telorun/analyzer": patch
---

A zone a library opens on a resource input now correlates, in `telo check` and in the load-time analysis, on the declaration the importer supplied for that input — per import of an `isolated` library, followed through a library that forwards an input of its own — as the kernel's instance comparison already did. A requirement on the importer's connection reached inside the library's transaction (a handler's `QueueSql.Enqueue` behind the library's `Domain.Emit`) is no longer `ZONE_REQUIREMENT_UNSATISFIED`, an importer's transaction on the connection it lent discharges a library export's requirement on that input, and such an export is no longer `ZONE_EXPORT_UNSATISFIABLE` at the library. A requirement on any other declaration, or on an optional input left unsupplied, is still refused.
