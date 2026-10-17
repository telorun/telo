---
"@telorun/cel": minor
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Load-time CEL now runs as emitted JavaScript. The kernel emits one module per manifest file and CEL environment, caches it as `<cache-root>/cel/<key>.mjs`, and evaluates every expression compiled at load through it; a later run imports the stored module after verifying its header and body, and re-emits one that does not match. With no cache root, or a read-only cache that does not hold the module, expressions keep running on the closure backend; a cache that cannot be written is reported once and the run continues on closures. The engine's emitted-module store may now supply `digest`, a host SHA-256 used for the module body in place of the built-in pure-JS one.
