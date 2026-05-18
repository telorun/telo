---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/benchmark": minor
"@telorun/http-server": minor
"@telorun/http-client": patch
---

`Bench.Suite.scenarios[*]` and `Http.Server.notFoundHandler` follow the canonical sibling shape: `invoke:` describes the dispatch target only; `inputs:` carries the call-time arguments as a sibling. The previously-accepted nested `invoke.inputs` form is gone — the benchmark runtime now reads `scenario.inputs` and the http-server runtime now reads `notFoundHandler.inputs`. Five benchmark manifests, one example, and `apps/registry/telo.yaml` migrated to the sibling form.

Statically validate CEL expressions inside `Telo.Definition` template bodies. The analyzer now registers `self` (typed from the definition's `schema:`) and `inputs` (typed from `inputType:`, falling back to the `extends:`-declared abstract's `inputType:`) as available variables in `resources:` / `invoke:` / `run:` / `provide:` / top-level `inputs:` / top-level `result:` fields, catching typos at load time instead of first invocation.

Aligns Telo.Definition's template-body shape with how Run.Sequence steps factor dispatch from data: `invoke:` / `provide:` / `run:` describe the dispatch target only; `inputs:` (values passed to the target) and `result:` (provide-only post-call mapping) live as top-level siblings on the definition. The previous nested `invoke.inputs` shape is gone — the kernel template controller now reads `definition.inputs`, and `modules/sql-repository/Read` migrates to the sibling form.

Inside top-level `result:`, the `result` CEL variable is typed from the dispatch target's `outputType:`. The produced top-level `result` value is also AJV-checked against the abstract this definition `extends` (`outputType`); top-level `inputs` is AJV-checked against the dispatch target's `inputType` when declared. Mismatches surface as a new `TEMPLATE_TARGET_MISMATCH` diagnostic.

Adds two reusable context-annotation forms used by the `Telo.Definition` builtin schema and available to any module that needs the same capabilities:

- `x-telo-context-from-root: "<path>"` — root-anchored navigation (replace semantics), used to type variables sourced from a top-level field regardless of where the CEL appears.
- `x-telo-context-from-ref-kind: "<refPath>#<field>"` — reads a kind name from `manifestRoot.<refPath>`, resolves it via the definition registry, and returns that kind's `<field>` schema.

Schema-extracted contexts are now sorted by scope specificity (longest first) so the first-match-wins resolver picks the most-specific context. No existing module relied on the previous ordering (no overlapping scopes), so this change is observably backward-compatible.
