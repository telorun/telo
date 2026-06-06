---
"@telorun/analyzer": minor
---

Add `AnalysisRegistry.acceptedKindsForRef(ref)` — the canonical (`module.Type`) kinds that satisfy an `x-telo-ref` constraint (an abstract expands to its implementations, a concrete kind yields itself), import-independent so it also covers locally-defined kinds. `userFacingKindsForRef` now derives from it. Lets editor hosts narrow ref candidates by kind satisfaction instead of base capability, so a slot typed to a specific abstract (e.g. an `Mcp.SessionProvider`) only offers that abstract's implementations rather than every `Telo.Provider`.
