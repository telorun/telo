---
"@telorun/kernel": patch
"@telorun/sdk": patch
---

A child manifest started through `ctx.runtime.run` that is refused — at load or before it finishes starting — now writes every diagnostic its failure carries to its stderr, after the unchanged headline: one `  [<CODE>] <message>` line each, a diagnostic's `details` beneath it, an import's nested root causes one level further in, and entries that failed only because another did left out. A refusal by the load's analysis used to write `Manifest validation failed` alone, so `Test.Suite`, `App.Instance` and `Assert.Manifest` could show — and a `runFails:` could match — nothing about its cause. The form is documented on `RuntimeSeam.run` and in the controller protocol spec (§9.2) as what every kernel writes for a refused child.
