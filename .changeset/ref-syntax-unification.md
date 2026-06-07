---
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/http-server": minor
"@telorun/mcp-server": minor
"@telorun/mcp-client": minor
"@telorun/run": minor
---

Unify resource references on the `!ref` YAML tag. The object form `{ kind, name }`
and bare-string references are removed: the analyzer rejects them up front
(`INVALID_REFERENCE_FORM`) and `!ref <name>` / `!ref <Alias>.<name>` is the only
authored shape. `resolveRefSentinels` now resolves `!ref` sentinels across the
whole manifest tree (including step `invoke`s and refs nested in inline
definitions), so every consumer sees the uniform resolved shape. The
http-server mount slot is renamed `mounts[].type` → `mounts[].mount`, and the
mcp transports / clients read their Phase-5-injected ref instances directly.

Schema validation (analyzer and kernel) now drops the stale scalar `type` a ref
slot may still pin (older published modules encode references as `type: string`)
before running AJV, so a resolved reference object validates against a legacy
`x-telo-ref` slot. This keeps an app that consumes a not-yet-republished
dependency analyzable and bootable during the migration. Object-typed ref slots
that also accept an inline value (e.g. `inputType` / `outputType`) are left
untouched.

`Run.Sequence` reference slots are brought onto the same enforcement path: a
step `invoke` and a scope `targets` entry now require a `!ref` (the `targets`
slot gains an `x-telo-ref` constraint and the `with` scope's visibility extends
to `/targets`), so a bare-string ref at either is rejected with
`INVALID_REFERENCE_FORM` at `telo check` — uniform with `Telo.Application`
targets — instead of failing as an obscure runtime error. The controller reads
the resolved reference rather than a bare name.
