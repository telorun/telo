---
"@telorun/run": minor
---

Expose a `Run.Sequence`'s caller inputs under the `inputs` CEL variable inside steps. Previously the controller spread caller inputs flat into the CEL scope, so `${{ inputs.x }}` (the documented contract) failed at runtime with "Unknown variable: inputs"; only sequences run directly (no inputs) were unaffected. Steps now read caller inputs as `${{ inputs.x }}`, matching the docs, while `error` continues to be threaded as a sibling key inside `try`/`catch`/`finally`.
