---
"@telorun/analyzer": patch
---

An expression in an import's field-by-field `needs:` supply reads the importing module's `variables` / `secrets` again. When the import's own `variables:` map held a `!cel` value, the supplied values were typed as the module's declarations, so reading any other declared variable was refused with `CEL_UNKNOWN_FIELD` (`"scratch" is not declared here (declared: workspaceDir)`) by `telo check` and at the kernel's load alike. Only a `Telo.Application` / `Telo.Library` document now declares those blocks; on any other document a `variables:` / `secrets:` field is values handed to something else.
