---
"@telorun/analyzer": minor
"@telorun/sdk": minor
---

An omitted argument map is now checked. Where a call through a reference slot paired by `x-telo-ref` `inputs:`, or a step, writes no `inputs:`, `telo check` judges it as the `default:` its property declares against the target's input contract and reports `CONTRACT_INPUTS_MISMATCH` at the reference, naming the default and asking for `inputs:`. A kind whose paired argument-map property may be omitted without a literal object `default:` (or whose pointer names no declared property) is refused at the declaring module as `ARGUMENT_MAP_DEFAULT_INVALID`, so `telo publish` refuses it. The built-in invoke step (a `Telo.Sequence` step and an Application's inline boot target) declares `inputs` with `default: {}`.
