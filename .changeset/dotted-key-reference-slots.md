---
"@telorun/analyzer": patch
"@telorun/kernel": patch
---

A reference slot declared under a property name that contains a dot (a `Ui.DesignTokens` token such as `font.body`) is now found. Before, the name was read as two nested keys, so an inline declaration written there passed `telo check` and was refused when the application started, and a `!ref` to a missing resource there passed `telo check` and failed at boot. Now the inline declaration is extracted and created like any other, and the missing reference is `UNRESOLVED_REFERENCE` at that key. An extracted declaration's `metadata.xTeloOrigin` gains `keysFromParent`, the keys and indices of where it was written, and its identity pointer is built from them (`brand#/font.body`). The analyzer's reach views gain the same places as segments beside their dotted spellings (`fieldKeys` on a reference, a declared reference and a position; `slotKeys` on a call-graph edge found through the reach), and inline extraction, scope enclosure and the zone passes compare places by those segments.
