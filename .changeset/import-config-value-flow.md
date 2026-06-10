---
"@telorun/kernel": patch
"@telorun/analyzer": patch
---

fix(kernel,analyzer): evaluate import `variables`/`secrets` against the importer's config

An import's `variables:`/`secrets:` values that contained CEL expressions (`${{ }}` or
`!cel`) were baked into the child library context **verbatim** — as unevaluated
compiled-value objects — instead of being evaluated against the importing module. So
config could not flow from an application through intermediate libraries into leaf
libraries: a nested `dbFile: "${{ variables.dbFile }}"` reached the leaf as an object and
crashed the consumer (e.g. `Sql.SqliteConnection`: `path must be of type string, got
object`).

Import inputs are now evaluated against the **importing module's `variables`/`secrets`**.
Resolution is eager and per-hop — each importer resolves its child's inputs from its own
already-settled config — so a value flows `app -> lib -> lib` at any nesting depth and a
leaf reads `variables.X` as an O(1) concrete lookup, with no chain-walk.

Import inputs are a config-only contract: the analyzer now type-checks these expressions
against the importer's `variables`/`secrets` (catching typos and fixing the prior
wrong-scope `!cel` false positive), and rejects `resources`/`env`/`ports` references —
runtime value-flow surfaces are deliberately out of scope here. To pass an env-derived
value into a library, bind it to a typed root `variables:`/`secrets:` entry and forward
`${{ variables.X }}` / `${{ secrets.X }}`.
