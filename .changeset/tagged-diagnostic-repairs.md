---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
"@telorun/sdk": minor
"@telorun/kernel": patch
"@telorun/cli": patch
---

A diagnostic's repair can be a tagged scalar. `DiagnosticFix` gains an optional `tag` (`ref` | `cel`), carried by `telo check -o json` (`fix.tag`), by `CheckDiagnostic` on the SDK's runtime seam, and by ide-support's `replace` suggestion; `renderFixReplacement` takes it as a third argument and writes `!ref <replacement>` or `!cel "<replacement>"`, so the VS Code quick fix now writes the tag instead of quoting it into the value.

`FUNCTION_TYPE_NAME_FORM` now repairs `schema: Money` as `{ replacement: "Money", tag: "ref" }` rather than the untaggable value `!ref Money`. `INVALID_REFERENCE_FORM` gains a repair for a bare-name string reference (`handler: onMessage` → `!ref onMessage`) — not for a dotted FQN or the `{ kind, name }` object, whose target would be a guess — and an untagged rule `condition:` (`RESOURCE_RULE_INVALID` / `REFERRER_RULE_INVALID`) is repaired by tagging the same expression `!cel`.
