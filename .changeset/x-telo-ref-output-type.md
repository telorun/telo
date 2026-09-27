---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/cli": minor
---

`x-telo-ref` gains an optional `outputType:` key — a JSON Schema the referenced target's output contract must be assignable to. `telo check` resolves the target's output the way `steps.<name>.result` is typed (the target's own `outputType`, its kind's, the keys of its `outputs:` map) and reports `REFERENCE_OUTPUT_MISMATCH` at the slot on a definite mismatch; a target declaring no output gets no verdict. A non-object value is `X_TELO_REF_INVALID_OUTPUT_TYPE`. The verdict is shared: `ManifestAnalysis.outputRefusal` and `AnalysisRegistry.outputRefusal` answer it for editors, and ide-support no longer completes a target (kind or resource) such a slot would refuse. Breaking for a module that adopts the key: an older analyzer refuses it as `X_TELO_REF_UNKNOWN_KEY`, so such a module declares a `requires: telo:` floor.
