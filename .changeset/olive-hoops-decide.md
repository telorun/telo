---
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/analyzer": patch
---

Publish the manifest the payload builder produced.

The `layers:` index was injected into `telo.yaml` during the push, after the
builder had already returned the manifest — so for every module shipping a
payload layer, the text a dependent hashed to derive its import pin was a
document no registry holds. 18 standard-library modules carried a pin that
could not resolve, and their consumers failed at load with an integrity error
naming a republish that never happened.

`ModulePayloadBuilder` now writes the index, so `publishedManifest()` returns
the shipping bytes. That requires layer framing to be a pure function of the
files it covers: `makeTarGz` pins every tar header field that is not the name
or the contents, which also makes artifacts reproducible. The index itself
comes from the transport (`Transport.layerIndex`), which owns that framing, and
publish now verifies each pushed blob against what the manifest already claims
rather than rewriting it.

Modules shipping a payload must republish — the wrong pins are in artifacts
that cannot be edited.
