---
"@telorun/analyzer": patch
---

A text with context written where a text or a text with values is accepted (`Ui.BoundText`, `{ text: Open, context: page }`) reaches its controller as one record. The text walk descended the text-with-values branch too, which the value cannot hold, and recorded a second text inside the first, so the controller received a record nested inside a record — a view failed with `ERR_OUTPUT_INVALID` at `/text/text` and a page node drew `ERR_UI_NODE_INVALID`, while `telo check` passed. The walk now skips a union branch that requires a member the value lacks, or is closed against one it holds.

A named shape that `extends` another is typed with its inherited members wherever a `!ref` to it is nested inside another shape (`items: !ref Child`). `telo check` registered the shape as written and reported `CEL_UNKNOWN_FIELD` for every inherited member read through such a reference, while the kernel accepted it. Parents resolve as the kernel resolves them — `<Module>.<Name>` names that module's shape, a bare name the declaring module's own — including a parent in an imported library that no exported declaration reaches.
