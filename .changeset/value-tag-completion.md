---
"@telorun/ide-support": minor
"@telorun/analyzer": minor
"telo-vscode": minor
"@telorun/studio": minor
---

Added: completion for a value's YAML tag. Typing `!` at a value (`root: !mo`) offers the tags that field takes — `!cel`, `!interpolate`, `!literal`, `!include-text`, `!include-bytes`, `!module-path`, or `!ref` alone at a reference slot — by the rule studio's schema form already applied: a tag's produced type must fit the field's declared schema (a union is compared branch by branch), and an expression tag is offered only where `telo check` evaluates the field. A field of an inline resource is resolved against its own kind. After `!include-text`, `!include-bytes` or `!module-path`, the value completes as a path relative to the module root (never the declaring file's directory), listing directories first, hiding dot-entries until the typed name starts with `.`, and offering nothing above the root or for an absolute path; a directory under a file-only tag inserts its `/` and reopens completion. VS Code and studio's source view gain `!` as a trigger character. The tag vocabulary is shared as `offeredValueTags` / `valueTag`, which studio's schema form now reads. `IdeEnvironmentAdapter` gains a required `listModuleEntries(relPath)`, resolved against the module root, and `CompletionResult` gains `retrigger` plus the `file` and `keyword` kinds. `AnalysisRegistry.celEvalModeAt(kind, path)` answers whether a field is evaluated, with the sites and gate the analysis pass uses for `CEL_IN_NON_EVAL_FIELD`.
