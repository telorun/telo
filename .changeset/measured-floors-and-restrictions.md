---
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/ide-support": minor
"@telorun/language-server": minor
"@telorun/studio": minor
---

A module's `requires.telo` is now a measured floor and a published version can be restricted after the fact. `requires.telo` is floor-only (`>=<version>` or `>=unreleased`); an upper bound in a module's own source is refused. A new `restrictions:` list on a library or application states what measurement cannot see (a ceiling found after publish, a runtime feature, a Node bound), each entry with a reason, and a later version's entries hold earlier versions back: running above a ceiling is the new `MODULE_REQUIRES_OLDER_RUNTIME`, a malformed entry is `RESTRICTIONS_INVALID` in `telo check` and at load. The load gate now applies to imported libraries too. `telo release floor` measures each workspace module's floor by running published CLIs, `telo release check` verifies it (`REQUIRES_FLOOR_TOO_LOW` / `REQUIRES_FLOOR_TOO_HIGH`), `telo publish` refuses `>=unreleased` and a `requires.telo` upper bound, and `telo upgrade`, the editor's upgrade lenses and Studio's version picker name the restriction that holds a version back.
