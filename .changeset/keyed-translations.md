---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/analyzer": minor
---

A library declares its own texts by key in a built-in `Telo.KeyedTranslations` (`keys:` of a message or `{ message, values?, description? }`, in the library's `lang:`), which registers the kind `<Module>.Translations` extending `Telo.Translations` with `lang` and a closed `messages:` map checked per key against its declared values. Per key and served language the source wording is the lowest layer and the application's listed catalogs of that kind apply over it in order. `x-telo-text-keys: [<Alias>.<Kind>]` on a kind's schema root names the keyed sets its resources show, and a kind naming none shows those of the nearest kind along `extends` naming any; written anywhere else — below the root, in `status:`, a contract, a named shape or a callable's parameters — it is refused (`TEXT_KEYS_INVALID` / `ERR_TEXT_KEYS_INVALID`); a controller reads them as `ctx.translations.keyed()`. The controller protocol's `Translations.Lookup` response gains the required `keyed`. The Rust kernel refuses `Telo.KeyedTranslations` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.
