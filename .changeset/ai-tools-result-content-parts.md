---
"@telorun/ai": patch
---

`Ai.Tools` entry `result:` accepts a content part or a list of parts, not just a string.

The runtime has always fed multimodal tool results back to the model — an image part is what makes a look-then-redraw loop possible — but `ToolEntry.result` was typed as `string`, so a mapping written in `!cel` form was rejected at `telo check` while the identical inline form passed. The type now matches what the controller has always accepted.
