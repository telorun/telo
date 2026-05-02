---
"@telorun/cli": patch
"@telorun/kernel": patch
---

Declare `engines.node: ">=24"` on `@telorun/cli` and `@telorun/kernel`. Makes the supported Node version explicit (and fixes the npm Node-version badge in the README, which previously rendered "not specified").
