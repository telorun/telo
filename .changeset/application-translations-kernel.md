---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/analyzer": minor
---

The Node kernel reads the root Application's `translations.catalogs` and layers them into one set the whole application is translated through, an imported library's texts included: per language a later catalog's translation of a text and context replaces an earlier one's. `Telo.TextTranslations` gets its built-in controller. A controller reaches the set as `ctx.translations` (also on a native function's context): `fallback` (the Application's `lang:`, `und` without one), `languages()` (the fallback and every catalog's language), `negotiate(preferences)` (RFC 4647 lookup per entry, malformed or unserved entries skipped, else the fallback) and `translate(lang, record)` / `translateAll(lang, records)` (the translation as a text record in the language reached, or the record itself). It is the controller protocol's new `Translations.Lookup`, in generation 8. The `x-telo-text-catalog-set` judgement is gone from the kernel, and with it the analyzer's `declaresTextCatalogSet`, `textCatalogSetMembers`, `textCatalogSetDuplicates` and `textCatalogSetProblems` exports and `ERR_TEXT_CATALOG_SET_INVALID`. The Rust kernel refuses `translations:` and a `Telo.TextTranslations` resource with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.
