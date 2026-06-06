---
"@telorun/cli": minor
"@telorun/templating": minor
"@telorun/kernel": minor
---

Add `telo cel functions` (list the CEL standard library — `--json` for tooling) and `telo cel eval "<expr>" [--context <json>]` (evaluate a CEL expression with the real Node handlers). Backed by a single-source CEL catalog: `@telorun/templating` now exports `celFunctionCatalog()` / `CEL_FUNCTIONS`, and `buildCelEnvironment` registers from it so the documented surface can't drift from what's registered. `@telorun/kernel` exports `nodeCelHandlers` (the Node `crypto`/`Buffer` implementations) so the CLI's eval matches a real run.
