---
"@telorun/sdk": patch
---

A nested step body records under the step that dispatched it, instead of restarting its journal paths at the root.

`InvokeContext` gains `durablePath`, the other half of the carriage the design specified: without it a nested body recorded `steps/<name>` for every body in a run, so two nested bodies with a same-named step shared one key. First-writer-wins then handed the second the first's RESULT — and when both dispatched the same target there was no mismatch to detect, so the run continued with a value produced for a different step.

The dispatching step's path now rides the context, so a nested engine hangs its keys under it (`steps/importAll/work` rather than a second `steps/work`). That is also what makes "a crash inside a nested body resumes inside it" true rather than aspirational.
