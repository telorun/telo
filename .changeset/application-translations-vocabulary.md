---
"@telorun/analyzer": minor
---

Add the built-in `Telo.Translations` (an abstract declaring only `lang`) and `Telo.TextTranslations` (translations matched by source text and context, the `TextCatalog` shape), and the Application-only `translations: { catalogs: [...] }` block listing them by `!ref` or inline. A catalog of another kind there is `REFERENCE_KIND_MISMATCH`, a text translated twice in one catalog stays `MESSAGE_ENTRY_DUPLICATE`, and a repeat across catalogs is an override. `translations:` on a Library is refused as `tracing:` is. `telo check` no longer reads `x-telo-text-catalog-set`, and `TEXT_CATALOG_SET_INVALID` is gone.
