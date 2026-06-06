---
"@telorun/templating": minor
"@telorun/sdk": minor
---

Add the `!sql` templating engine for safe, dialect-neutral SQL interpolation. A `!sql "… ${{ expr }} …"` scalar evaluates to a parameterized value — literal fragments plus the separately-evaluated value of each interpolation — instead of a joined string, so consumers can emit driver-native placeholders and bind the values rather than splicing them into the SQL text.

Supporting additions: `@telorun/sdk` gains an optional `parts` field on `CompiledValue` (an interpolated template's segments before they are joined) plus the shared `ParameterizedSql` type and `isParameterizedSql` guard (the marker contract producers and consumers single-source). `@telorun/templating` adds `toParameterized(value, ctx)`, which splits a value into `{ fragments, values }` and backs the new engine.
