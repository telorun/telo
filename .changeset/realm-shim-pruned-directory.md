---
"@telorun/kernel": patch
---

A controller bundle whose cache directory was pruned and written back since this kernel first prepared it — by another kernel sharing the workspace cache, or by this one after an edit was undone — gets its `@telorun/sdk` package written again before it is imported, instead of failing to resolve the SDK.
