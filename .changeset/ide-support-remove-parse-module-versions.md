---
"@telorun/ide-support": minor
---

Removed: `parseModuleVersions`. Editors read the hub's `GET /module/versions` answer through `@telorun/language-host`'s `HubClient`, which applies the same rules (newest first, an entry without a version dropped, a non-canonical `integrity` discarded).
