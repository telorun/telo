---
"@telorun/kernel": patch
---

A module's controller bundle is prepared once per load instead of once per kind: the build-index read, the stat of every build input, the existence checks and the `node_modules/` shims beside the bundle are shared by every kind the module's bundle serves, and cleared with the rest of the load's artifact state, so the next load sees an edit as before. A load instantiating many kinds of one module spends far fewer event-loop turns on the filesystem, which kept a kernel running beside other work in one process (`Test.Suite`, `Assert.Manifest`, `App.Instance`) waiting behind that work once per kind.
