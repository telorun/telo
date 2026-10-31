---
"@telorun/studio": minor
---

The topology view gains a configuration picker for a module that writes `!if` / `!switch` choices: one select per dimension the choices read — a library's `resources.<input>` presence included — each starting at its default, and the module graph is redrawn in the picked configuration. A declaration-position choice stays one box as the picker changes its kind and shows the alternative it takes; a template body's family is drawn as one box marked with the collection it repeats over and a `!for-each` in a list as one row. Saving a module keeps every `!if` / `!switch` / `!for-each` tag, its mapping, key order and `...` keys as written.
