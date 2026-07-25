---
"@telorun/editor": minor
---

Add starter templates and hub-backed import search.

Starter templates: a curated set (fetched over http(s), not bundled) offered on
first run and when creating a module, via a shared dialog — pick a name, then a
template or blank. Add-import now searches the telo hub and guards against
silently clobbering an existing import alias.
