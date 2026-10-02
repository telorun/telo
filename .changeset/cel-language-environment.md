---
"@telorun/templating": patch
---

`buildCelLanguageEnvironment()` returns the bare CEL language environment under Telo's options — cel-js's built-ins with no Telo catalog — on which `buildCelEnvironment()` now builds the dialect.
