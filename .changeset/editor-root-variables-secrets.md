---
"@telorun/editor": patch
---

feat(editor): edit variables/secrets on the app/library node detail panel

Selecting the application/library node now renders an editable variables/secrets
form (reusing the schema form) instead of a read-only summary. The form branches
on the module kind: Application entries are host env bindings (`env` + `type`),
while Library entries are plain JSON-Schema declarations (no `env`). Each entry's
fields render inline in a horizontal row via a `flat` prop on the schema-form
components (an editor layout choice, not a schema annotation), so `type`/`env`
are visible without expanding a per-entry accordion.

The module root is written through the generic `setResourceFields` (resolved via
an owner-doc fallback), retiring the bespoke `setApplicationTargets`;
`diffFields` now treats tagged `!ref`/`!cel` sentinels as opaque leaves so
reference arrays like `targets` round-trip without losing their tags.
