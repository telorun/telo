---
"@telorun/analyzer": patch
---

A named shape a library exports is read by its importers exactly as when it is not exported: its own `!ref`s resolve in its declaring module and the shapes they name are carried with it. Before, exporting such a shape left its references unresolved, so an importer's call sites against a contract naming it were silently unchecked, or `telo check` aborted with an uncoded "does not compile where it stands" error when a value slot typed by it held an expression beside a failing union. The stand-in judge also resolves a reference exactly as the whole-schema validation did.
