---
"@telorun/sdk": minor
"@telorun/kernel": minor
---

A child application's own needs can be supplied by name. `ctx.runtime.run(source, { inputs: { needs } })` takes the fields of each of the child's root `needs:`, keyed by need name, and the child answers a need supplied that way before its environment (`env:`-bound name or `TELO_NEED_…`) and before the host values (`TELO_HOST_STATE_DIR`, the address templates); a `supply: root` type is accepted. The child refuses at load a need name it does not declare (`ERR_MANIFEST_VALIDATION_FAILED`, naming the needs it declares), a field its type does not declare or whose value it refuses, a required field left out (`ERR_NEED_PARTIALLY_SUPPLIED`), and a durable directory it cannot use (`ERR_NEED_DIRECTORY_UNUSABLE`, naming the calling resource). The controller protocol's `Runtime.Run.inputs` gains `needs`, which is protocol generation `telo-7`.
