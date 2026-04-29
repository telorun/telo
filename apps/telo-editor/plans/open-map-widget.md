# Plan: open-map widget for ResourceSchemaForm

## Goal

Render `type: "object"` schemas with `additionalProperties: <schema>` as a string-keyed map editor — list of `(key, value)` rows where the value form is rendered recursively from `additionalProperties`. Generic across HTTP headers, env vars, options bags, response content maps, secret maps, and any future map-shaped manifest field.

## Routing change in `FieldControl`

[apps/telo-editor/src/components/resource-schema-form/field-control.tsx](../src/components/resource-schema-form/field-control.tsx) currently routes `kind === "object"` without `properties` to `JsonSchemaField` (a JSON Schema editor — wrong for non-schema maps). New ordering:

1. `x-telo-ref` present → `ReferenceSelectField` (unchanged).
2. `kind === "object"` AND `prop.properties` → `ObjectField` (unchanged).
3. `kind === "array"` AND `prop.items.type === "object"` → `ArrayObjectField` (unchanged).
4. **NEW**: `kind === "object"` AND `prop.additionalProperties` is a non-trivial schema → `MapField`.
5. `kind === "object"` (catch-all) → `JsonSchemaField` (unchanged — fires only for genuine JSON-Schema-editor cases like `Config.Env.schema`).
6. `kind === "array"` → `UnsupportedField` (unchanged).
7. scalar → `ScalarField` (unchanged).

"Non-trivial schema" for branch 4 means `additionalProperties` is an object with at least one of: `type`, `oneOf`, `anyOf`, `properties`, `x-telo-ref`. Bare `additionalProperties: true` and `additionalProperties: {}` keep falling through to branch 5 (free-form JSON object).

## `MapField` behavior

Component file: `apps/telo-editor/src/components/resource-schema-form/map-field.tsx`.

- Renders a list of rows. Each row: `[key input] [value sub-form] [remove button]`.
- Empty value → no rows, "+ Add entry" button only.
- "Add entry" button at the bottom inserts a new row with empty key and a value initialized from the value schema's defaults.
- Key edits update the underlying object: removing the old key, setting the new key, preserving value by reference. Duplicate keys are flagged inline (red border + tooltip); the form's `onParseStateChange` reports the error so save is gated.
- Empty keys are flagged the same way (the row exists, but the entry is not committed to the underlying object until the key is non-empty).
- Value sub-form is `FieldControl` rendered against `additionalProperties` schema with `fieldPath = ${parentPath}.${key}`.
- Row reordering: not supported in v1 (object property order is not semantically meaningful).

## Key validation

- `propertyNames.pattern` (JSON Schema standard) is honoured: keys not matching the regex are flagged inline.
- Duplicate keys: flagged inline.
- Empty keys: flagged inline.
- Validation errors propagate to `onParseStateChange` so the parent form blocks saves until cleared.

## Empty state

Value `undefined`, `null`, or `{}` → render only the "+ Add entry" button. No invisible state.

## Removed-key cleanup

When a row is removed, the underlying object's key is deleted (not set to `undefined`) — `onValueChange` emits a clean object so YAML round-trips don't carry orphan nulls.

## File-level work breakdown

1. `apps/telo-editor/src/components/resource-schema-form/map-field.tsx` — new component.
2. `apps/telo-editor/src/components/resource-schema-form/field-control.tsx` — add branch 4 (MapField) before the existing JsonSchemaField catch-all. Update `inferType` / `willRenderAsObjectField` if needed for label-ownership decisions.
3. `apps/telo-editor/src/components/resource-schema-form/types.ts` — extend `JsonSchemaProperty` typing with `additionalProperties?: JsonSchemaProperty | boolean` and `propertyNames?: { pattern?: string }`.

## Coverage check (existing fields that benefit immediately)

Once routing branch 4 lands, these stop rendering as JsonSchemaField and start rendering as MapField:

- `Http.Client.headers` (`additionalProperties: { type: string }`)
- `Http.Server.cors.*Headers` array variants — N/A (those are arrays, not maps)
- `Http.Api.returns[].headers` (`additionalProperties: { type: string }`)
- `Http.Api.returns[].catches[].headers` (same)
- Future: `Http.Api.returns[].content` (this plan's downstream consumer — see [modules/ai/plans/text-stream-tests.md](../../../modules/ai/plans/text-stream-tests.md))
- Future: env-vars, secrets maps, options bags

`Config.Env.schema` keeps falling through to branch 5 (JsonSchemaField) because its value schema is `type: "object"` with no `type`/`oneOf`/`x-telo-ref` qualifier — it matches "free-form JSON" not "typed-value map". Confirms the routing is right.

## Out of scope

- Drag-to-reorder rows.
- `x-telo-suggestions` autocomplete for keys (separate ergonomic enhancement; routes through the same `MapField` once added).
- Bulk paste / "import as JSON" affordances.
- Per-key custom validation messages beyond `propertyNames.pattern`.
- Treating `patternProperties` (multiple schemas keyed by regex) — defer until a manifest schema actually uses it.
