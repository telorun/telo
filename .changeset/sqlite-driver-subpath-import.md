---
"@telorun/sql": patch
---

Fix `Sql.SqliteConnection` failing to load under the controller bundler with
`ERR_UNSUPPORTED_ESM_URL_SCHEME` (`Received protocol 'bun:'`). The driver was
selected with a `typeof Bun` guard plus relative `import("./sqlite-driver-bun.js")`
/ `import("./sqlite-driver-node.js")` calls; bundling inlined both drivers and
hoisted `bun:sqlite` into an unconditional top-level static import that Node's
ESM loader rejects before the guard runs. The connection now imports the
package's own `@telorun/sql/sqlite-driver` subpath export, which the bundler
externalizes and the resolver maps per runtime (Bun → `bun:sqlite`, Node →
`better-sqlite3`).
