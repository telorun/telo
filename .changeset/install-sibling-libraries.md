---
"@telorun/kernel": minor
"@telorun/cli": minor
---

`telo install` now resolves sibling module libraries, so a bundled controller that
imports another module's `exports.code:` entry point (`@telorun/ai`,
`@telorun/cache`, …) installs instead of failing with "Cannot find package". The
join `kernel.load()` performs is exported as `buildSiblingLibraries` and computed
by the install warm pass, which already holds all three inputs.
