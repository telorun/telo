# Reading a catalog set from another module

A module whose controller translates on its own — a renderer translating a page on the server, say — holds an `I18n.Translator` through a reference slot and reads its catalogs with the code this module exports as `@telorun/i18n`:

```ts
import { catalogSetOf } from "@telorun/i18n";

const set = catalogSetOf(resource.translator);
set.languages;                     // ["pl", "de"] — the catalog languages, in the translator's order
set.lookup(textRecord, "pl-PL");   // { message, lang: "pl" } | null
```

`catalogSetOf` takes either form a holder receives a translator in:

- the live instance, at a slot whose use is not `dependency` for a function — the set the translator built when it was created;
- the translator's configuration, delivered as data at a native function's `use: dependency` slot (`{ catalogs: [{ lang, texts }] }`) — the set is built from it.

Anything else is a `TypeError`.

`lookup(text, lang)` takes the `Text` record the kernel hands a controller (`{ text, context, lang, computed }`) and one language tag, and answers the translation the translator would format — the requested tag, then each shorter variant, compared without regard to case — as the parsed message and the language of the catalog it came from. It answers `null` when no catalog translates the text, and for a computed text, which is never looked up; the caller then uses the record's own message in the record's `lang`. Format the answer with the message core the SDK re-exports (`formatMessage`), so every runtime and every browser gives one result.

The module's controller bundle is one scope across every dependent, so the translator a controller holds and the reader it imports share one set. Declare the dependency in the consuming module's `imports:`; the kernel resolves the specifier to this module's entry point.
