---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Add the built-in `Telo.Sequence`: an ordered list of steps with `with:`, `targets:`, `inputType`, `outputType` and `outputs`, needing no import. `telo builtins Sequence` prints it. The Rust kernel refuses a `Telo.Sequence` resource with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.

A resource of a kind that inherits its controller is now one instance, created by the nearest ancestor's controller in the context that owns the resource. Without `base:`, everything the resource declares — step targets, CEL reads, `with:` scopes — resolves in its own module, as for a resource of the ancestor; with `base:`, the mapping runs in the module that wrote it, and a `!ref` it writes names that module's resource. A template body, an `inputs:` / `result:` mapping and the controller's own files resolve in the module of the definition holding them.

`throws:` now resolves to the nearest declaration along `extends`: a kind declaring none throws what its ancestor declares, so a `catches:` naming such a code is no longer refused, and the dispatch exit no longer reports it as undeclared. An `inherit` union reads what the controller receives — what a `base:` mapping builds, a verbatim `self.<path>` standing for the resource's value there — and is unbounded where a mapping computes what it drives.
