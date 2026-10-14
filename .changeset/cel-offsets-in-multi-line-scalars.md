---
"@telorun/analyzer": patch
"@telorun/language-server": patch
---

CEL inside a folded block scalar (`>`, `>-`) or a quoted or plain scalar spanning several lines is located on the characters the author wrote. Before, every node's range in such a body was shifted, so editor colouring, hover, go-to-definition, CEL diagnostics and rename landed on the wrong text.
