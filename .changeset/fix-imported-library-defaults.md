---
"@telorun/kernel": patch
---

Apply a `Telo.Library`'s declared `variables` / `secrets` `default:` values when
the importer provides no override. Previously the import controller seeded the
child scope only from the importer-supplied inputs, so a contract variable with a
`default:` but no override reached the library's `${{ variables.X }}` templates as
a missing key (`No such key: X` — value was an empty object `{}`), even though
static analysis validated the reference against the defaulted contract. This
mirrors the root Application's env defaulting; child modules remain isolated from
the host environment, so the resolved value is the importer's override else the
library default.
