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

"Non-trivial schema" for branch 4 means `additionalProperties` is an object (`typeof === "object" && !Array.isArray && value !== null`) AND has at least one of: `type`, `oneOf`, `anyOf`, `properties`, `x-telo-ref`, `$ref`, `const`, `enum`. The object-ness check is explicit because `additionalProperties: {}` is also `typeof === "object"`; only the qualifying-keys check distinguishes it from a real value schema. Bare `additionalProperties: true`, `false`, and `{}` keep falling through to branch 5 — see [Out-of-scope shapes](#explicitly-out-of-scope-and-why).

The qualifying-keys list is deliberately schema-shape complete: `$ref` covers shared definition references, `const` and `enum` cover literal-value maps. Anything missing here would silently misroute to `JsonSchemaField`, which is worse than a typed `additionalProperties` rendering as the wrong widget.

The CEL wrapper applied by `FieldControl` after `renderInner()` is **not** suppressed for MapField. This matches the existing behavior for `ObjectField` / `ArrayObjectField`: the whole field can still be toggled to a CEL expression (e.g. `${{ variables.headers }}`) at the container level, and individual value cells inside the map get their own per-cell CEL toggle naturally because each value is rendered through `FieldControl`.

### Self-headed-field predicate split

`willRenderAsObjectField` at [field-control.tsx:41-48](../src/components/resource-schema-form/field-control.tsx#L41-L48) does double duty today: callers in `index.tsx`, `object-field.tsx`, and `array-object-field.tsx` use it to suppress the parent label, while `field-control.tsx:157` uses it to suppress the bottom description div. ObjectField happens to handle both (label inside its trigger, description inside its trigger), so the conflation hasn't bitten yet.

To stop the predicate name from lying once a third self-headed field type lands, split into two predicates colocated in `field-control.tsx`:

- `ownsLabel(prop)` — true when the renderer draws its own field title; callers omit the parent label.
- `ownsDescription(prop)` — true when the renderer draws `prop.description` itself; callers skip the bottom description row.

For both ObjectField and MapField, both predicates return true (description rendered inside the collapsible trigger, like ObjectField does today). Removing `willRenderAsObjectField` is a mechanical rename across four files. Future field types declare their own header semantics by appearing in either or both predicates without overloading a third.

## `MapField` behavior

Component file: `apps/telo-editor/src/components/resource-schema-form/map-field.tsx`.

### Layout

- Collapsible card (Radix `Collapsible`, same wrapper shape as `ObjectField`) so deeply nested maps don't dominate the form. The header holds, in order: collapsible chevron, title (from `prop.title` or the `label` prop, fallback `"map"`), `prop.description` (rendered inline beside the title in muted text — same treatment as `ObjectField`'s trigger at [object-field.tsx:79-83](../src/components/resource-schema-form/object-field.tsx#L79-L83) so descriptions on map fields don't disappear), and a right-aligned entry count.
- Inside the collapsible: a list of rows. Each row is `[key input] [value sub-form] [remove button]`.
- "+ Add entry" button at the bottom of the row list.
- Empty value (`undefined`, `null`, or `{}`) → collapsible expanded by default with only the "+ Add entry" button visible. No phantom rows.
- Optional Clear button in the header (mirrors `ObjectField`) when `required === false` and the value is non-empty.

### Local row state — controlled-with-buffer pattern

The map cannot be a thin projection of the underlying object: while a user types `Authorization` character-by-character, we don't want intermediate keys (`A`, `Au`, `Aut`…) thrashing the YAML object, and reordering on rename would corrupt source diffs. MapField holds **internal row state**:

```ts
type Row = { id: string; key: string; value: unknown };
const [rows, setRows] = useState<Row[]>(() => deriveRows(value));
```

- `id` is a stable per-row identifier from an **instance-scoped** counter held in a ref:

  ```ts
  const counterRef = useRef(0);
  const newId = () => `r${++counterRef.current}`;
  ```

  Instance scope avoids two failure modes a module-level counter would hit: (a) Vite HMR resets module state, breaking row identity mid-edit, and (b) two MapField instances mounted on the same form would share the counter and produce the same path suffix `r1`, `r2`, …. Since `id` is also used as a React key and as the `fieldPath` suffix that flows into `onErrorChange`, collisions would corrupt error tracking and key-based reconciliation.
- `deriveRows(value)` walks `Object.entries(value)` in insertion order and assigns fresh IDs from `counterRef`.
- Serialization: rows are reduced to an object **in row order** (preserves YAML diff sanity on rename); only rows with a *committable* key are included (see [Key validation](#key-validation)).

### External value resync

A ref tracks the last object emitted by MapField:

```ts
const lastEmittedRef = useRef<unknown>(value);
useEffect(() => {
  if (!shallowEqualObject(value, lastEmittedRef.current)) {
    setRows(deriveRows(value));
    lastEmittedRef.current = value;
  }
}, [value]);
```

`shallowEqualObject(a, b)` is added as part of this work to `apps/telo-editor/src/lib/utils.ts` (the file currently exports only `cn` and `isRecord`). Definition: returns `true` when `a` and `b` are both plain objects (`isRecord`) with identical key sets and `Object.is`-equal values for every key, or when both are nullish. This is sufficient for value comparison here because emitted maps are always one level deep — nested values in headers/queries/etc. are scalars or strings, and a deeper change at the parent level invalidates `value` reference identity already.

This handles file reload / undo / sibling-edit. Pending rows with invalid keys (not yet present in the emitted object) are dropped on resync; the user must re-add them. This is intentional: a row that has never been committed to the source-of-truth value cannot be reconciled with an external change without inventing merge semantics.

### Add / remove / rename / value edit

- **Add**: `setRows([...rows, { id: newId(), key: "", value: defaultFor(additionalPropertiesSchema) }])`. The new row has an empty key — invalid, so the row exists in UI only and is not yet committed to the object until the user types a valid key. Triggers no `onValueChange`.
- **Remove**: drop the row by id; emit serialized object (key is deleted, not set to `undefined`, so YAML round-trips clean).
- **Rename** (key edit): mutate `key` on the row; emit serialized object. Because serialization walks `rows` in order and the row id is unchanged, the renamed key keeps its position in the emitted object — no end-of-object jumps.
- **Value edit**: mutate `value` on the row; emit serialized object. The value sub-form is `FieldControl` rendered against `additionalProperties` schema with `fieldPath = ${parentPath}.${row.id}`. The row id (not the key) is used so partial / invalid / colliding keys don't produce ugly or duplicate paths. Dot-segment notation matches the existing `ArrayObjectField` convention (`${fieldPath}.${index}.${itemName}` at [array-object-field.tsx:125](../src/components/resource-schema-form/array-object-field.tsx#L125)) so any future path parser can treat the entire form's paths as a single flat dotted vocabulary; bracket notation would falsely imply array indexing.

Default value for new rows is built via the shared `buildEditorDefaultValue` helper extracted from `array-object-field.tsx` — see [Refactor](#refactor-shared-default-value-helper).

## Key validation

Per-row, evaluated locally in MapField:

| Condition | Severity | Effect on serialization |
| --- | --- | --- |
| empty key | error | row excluded from emitted object |
| duplicate key (collides with another row's key) | error | first occurrence committed; later occurrences excluded |
| key fails `propertyNames.pattern` (if present) | error | row excluded from emitted object |

When multiple errors apply to one row, precedence is **empty > duplicate > pattern** for the displayed message; all are reflected in the field state regardless. Errors render as a red border on the key input plus a tooltip with the message.

`propertyNames` may carry a full JSON Schema, but MapField honours only `propertyNames.pattern` — other constraints are ignored. See [Known limitations](#explicitly-out-of-scope-and-why).

## Error propagation to the parent form

`onParseStateChange` exists on `ResourceSchemaForm` but is currently a stub: [index.tsx:38-40](../src/components/resource-schema-form/index.tsx#L38-L40) calls it once with `false` on mount. There is no path for child fields to surface validation errors. MapField is the first field that needs it, so this work lands here.

### Plumbing

Add an optional callback to `FieldControl` that bubbles up by field path:

```ts
interface FieldControlProps {
  /* ...existing... */
  onErrorChange?: (fieldPath: string, hasError: boolean) => void;
}
```

- `FieldControl` forwards `onErrorChange` unchanged to all child renderers (`ObjectField`, `ArrayObjectField`, `MapField`, future fields). Each child also forwards it down recursively through nested `FieldControl` calls. Scalar leaves never call it — they have no intra-field validation; their values are either parseable for the schema kind or already represented as raw strings in the model.
- MapField computes its row-error state synchronously from `rows` on each render. It tracks the previously reported boolean in a ref and calls `onErrorChange?.(fieldPath, next)` from a `useEffect` only when the boolean transitions, so `useCallback`-stable callers do not loop.

#### Cleanup contract — every `true` must be paired with a `false`

This is a correctness requirement, not optimization. The aggregator's `errorPathsRef` is keyed by `fieldPath`, and any path left in the Set after its source goes away latches `hasFormErrors=true` and silently freezes saves.

MapField (and any future error-reporting field) must report `false` on:

1. **Error transition**: when row errors clear via the row's path (already covered by the synchronous diff above).
2. **Component unmount**: a `useEffect` cleanup that always emits `onErrorChange?.(fieldPath, false)` regardless of last reported state. This covers parent ArrayObjectField row removal, DetailPanel resource navigation, and tab/drawer close.
3. **fieldPath change**: the `useEffect` that reports transitions is keyed on `[fieldPath, errorBool]`; the cleanup additionally fires `false` for the *previous* `fieldPath` value when the path itself changes (e.g. an ancestor index shifts). React runs effect cleanup with the previous dependency snapshot, so capturing the previous `fieldPath` in a ref and emitting `false` for it in cleanup is the correct pattern.

The cleanup contract is a documented part of the `onErrorChange` interface — `FieldControl`'s prop comment must state "callers MUST emit `false` for any path they previously emitted `true` for, including on unmount and fieldPath change". MapField is the only current implementer; future implementers adopt the same pattern.

`ResourceSchemaForm` collects errors into a `Set<string>` keyed by `fieldPath`:

```ts
const errorPathsRef = useRef<Set<string>>(new Set());
const onErrorChange = useCallback((path: string, hasError: boolean) => {
  const prev = errorPathsRef.current.size > 0;
  if (hasError) errorPathsRef.current.add(path);
  else errorPathsRef.current.delete(path);
  const next = errorPathsRef.current.size > 0;
  if (prev !== next) onParseStateChange?.(next);
}, [onParseStateChange]);
```

The mount-time `onParseStateChange?.(false)` stub at [index.tsx:38-40](../src/components/resource-schema-form/index.tsx#L38-L40) is **kept and rebound to schema identity**. Removing it entirely would regress resource navigation in `DetailPanel`, which keeps `hasFormErrors` state across resource switches: opening a clean resource B after errors on resource A would inherit the latched `true`. The stub becomes:

```ts
useEffect(() => {
  errorPathsRef.current.clear();
  onParseStateChange?.(false);
}, [schema, onParseStateChange]);
```

Keying on `schema` resets both the aggregator and the parent's parse-state when the form rebinds to a different schema. Within a single schema, transitions are driven entirely by `onErrorChange` calls.

### Consumer wiring

Save-gating must land alongside the plumbing because pending invalid rows live in MapField's local state and are excluded from the serialized object. Without gating, a blur-driven save persists the parent's view of `values` (which omits the pending rows) and the user's in-progress key silently disappears.

**`DetailPanel`** ([components/DetailPanel.tsx](../src/components/DetailPanel.tsx)):

```tsx
const [hasFormErrors, setHasFormErrors] = useState(false);

useEffect(() => {
  setHasFormErrors(false);
}, [selectionContext]);

// ...
<ResourceSchemaForm
  /* ...existing props... */
  onParseStateChange={setHasFormErrors}
  onFieldBlur={() => {
    if (hasFormErrors) return;  // hold the save until errors clear
    applyPointerEdit(pointerFields);
  }}
/>
```

The `selectionContext`-keyed reset belts-and-braces against any latched state when the user navigates between resources or changes pointer selection. The schema-keyed reset inside `ResourceSchemaForm` covers the form-internal reset; this one covers the consumer-state reset. Both are needed because `hasFormErrors` lives in `DetailPanel`, not in the form.

When `hasFormErrors` flips back to `false`, no auto-save fires; the user's next blur on a clean field commits everything. This matches the existing per-blur save model — errors simply postpone the next blur's effect.

**`AdapterConfigForm`** ([run/ui/AdapterConfigForm.tsx](../src/run/ui/AdapterConfigForm.tsx)) is intentionally **not** wired with parse-state propagation. The actual parent — `RunSettingsSection` ([run/ui/RunSettingsSection.tsx:148-166](../src/run/ui/RunSettingsSection.tsx#L148-L166)) — has only a Recheck button; there is no Apply or Run gate to thread the state into. Adding `onParseStateChange` to `AdapterConfigForm` and `RunSettingsSection` without a consumer would land dead props. When run-execution gating is designed (separate change), it can adopt the same pattern as `DetailPanel`. Until then, the user-visible behavior in adapter forms is: pending invalid map rows render with a red border + tooltip and are excluded from `value` (current behavior — silent omission). This is a known limitation of the run-config UX, not of MapField.

The obsolete `fieldErrors`-follow-up comment in [AdapterConfigForm.tsx:11-15](../src/run/ui/AdapterConfigForm.tsx#L11-L15) is updated to point at the same future work (run-gating), since the original "inline per-field errors require a `fieldErrors` prop" claim is now stale — MapField provides the inline error rendering directly.

## Empty state

Value `undefined`, `null`, or `{}` → render the collapsible expanded with only the "+ Add entry" button. No invisible state, no auto-inserted blank row.

## Removed-key cleanup

Removing a row deletes the key from the emitted object (not set to `undefined`) so YAML round-trips don't carry orphan nulls. Same convention as `ObjectField` / `ArrayObjectField`'s `setObjectChild` helper.

## Refactor: shared default-value helper

`buildDefaultValue(prop, resolvedResources)` currently lives in [array-object-field.tsx:19-39](../src/components/resource-schema-form/array-object-field.tsx#L19-L39). Extract it to `apps/telo-editor/src/components/resource-schema-form/default-value.ts` as `buildEditorDefaultValue` and import from both `ArrayObjectField` and `MapField`. The rename is deliberate — the helper is editor-coupled (it consumes `ResolvedResourceOption[]` and is aware of `x-telo-ref` defaults), so the scoped name discourages future contributors from lifting it into `lib/utils.ts` as a generic JSON Schema utility. Pure refactor otherwise.

## File-level work breakdown

1. `apps/telo-editor/src/lib/utils.ts` — add `shallowEqualObject(a, b)`.
2. `apps/telo-editor/src/components/resource-schema-form/default-value.ts` — new file; extract `buildEditorDefaultValue` from `array-object-field.tsx`.
3. `apps/telo-editor/src/components/resource-schema-form/array-object-field.tsx` — replace local `buildDefaultValue` with `buildEditorDefaultValue` import; forward `onErrorChange` through nested `FieldControl` calls; replace `willRenderAsObjectField` callsite with `ownsLabel`.
4. `apps/telo-editor/src/components/resource-schema-form/map-field.tsx` — new component (instance-scoped `counterRef`, `shallowEqualObject`-gated resync, dot-notation `fieldPath`, unmount/path-change error cleanup).
5. `apps/telo-editor/src/components/resource-schema-form/field-control.tsx` —
   - add branch 4 (MapField) before the `JsonSchemaField` catch-all using the schema-shape-complete predicate,
   - add `onErrorChange` prop with cleanup-contract docstring; forward to all child renderers,
   - replace `willRenderAsObjectField` with `ownsLabel` and `ownsDescription`; both return true for ObjectField-routed and MapField-routed props.
6. `apps/telo-editor/src/components/resource-schema-form/object-field.tsx` — forward `onErrorChange` through nested `FieldControl` calls; replace `willRenderAsObjectField` callsite with `ownsLabel`.
7. `apps/telo-editor/src/components/resource-schema-form/index.tsx` —
   - implement the error-path Set aggregator and pass `onErrorChange` into the top-level `FieldControl`,
   - replace mount-only `onParseStateChange?.(false)` with a schema-keyed reset (clears `errorPathsRef` and emits `false` whenever `schema` identity changes),
   - replace `willRenderAsObjectField` callsite with `ownsLabel`.
8. `apps/telo-editor/src/components/resource-schema-form/types.ts` — extend `JsonSchemaProperty` with `additionalProperties?: JsonSchemaProperty | boolean` and `propertyNames?: { pattern?: string }`.
9. `apps/telo-editor/src/components/DetailPanel.tsx` — track `hasFormErrors`, reset on `selectionContext` change, gate `applyPointerEdit` on it.
10. `apps/telo-editor/src/run/ui/AdapterConfigForm.tsx` — update the header docstring to reference run-execution gating (separate work) instead of the now-stale `fieldErrors` follow-up. No prop changes; `RunSettingsSection` has no save/run gate to wire into yet, so threading parse state up would land dead props (see [Consumer wiring](#consumer-wiring)).

## Coverage check (existing fields that benefit immediately)

Once routing branch 4 lands, these stop rendering as `JsonSchemaField` and start rendering as `MapField`:

- `Http.Client.headers` (`additionalProperties: { type: string }`)
- `Http.Client.requests[].query` (`additionalProperties: { type: string }`)
- `Http.Client.requests[].headers` (`additionalProperties: { type: string }`)
- `Http.Api.returns[].headers` (`additionalProperties: { type: string }`)
- `Http.Api.returns[].catches[].headers` (same)
- Future: `Http.Api.returns[].content` (this plan's downstream consumer — see [modules/ai/plans/text-stream-tests.md](../../../modules/ai/plans/text-stream-tests.md))
- Future: env-vars, secrets maps, options bags

`Config.Env.schema` keeps falling through to branch 5 (`JsonSchemaField`) because its value schema is `type: "object"` with no `type` / `oneOf` / `x-telo-ref` qualifier — it matches "free-form JSON" not "typed-value map". Confirms the routing is right.

## Explicitly out of scope (and why)

These shapes do not block adoption of MapField for the active consumers (HTTP headers, queries, return headers). They are listed so a future contributor doesn't mistake the omissions for unintentional gaps:

- **`additionalProperties: true` and `additionalProperties: {}`** keep routing to `JsonSchemaField`, which interprets the value as a schema declaration rather than a free-form key/value map. This is wrong for free-form maps in principle, but no module schema in the repo uses these shapes — adding a dedicated free-form-JSON value cell would be speculation. The branch-4 predicate is intentionally conservative so that adding such a schema later is a one-line predicate change, not a routing rewrite.
- **`properties` + `additionalProperties` combo** (a closed-shape object with an open string-keyed tail) routes to `ObjectField` and the open tail is invisible. No current schema uses this combo. Adding it would require ObjectField to host a tail MapField, which is a layout decision that has no anchor today.
- **`patternProperties`** (multiple value schemas keyed by regex) is not supported. No current schema uses it; supporting it requires picking a value schema per row by matching the key against multiple patterns, which has no clean UI today.
- **`propertyNames` constraints other than `.pattern`** (`minLength`, `maxLength`, `enum`, etc.) are ignored. `.pattern` covers all current real uses (header-name shapes, env-var-name shapes).
- **Drag-to-reorder rows.** Object property order is not semantically meaningful for the underlying use cases (headers, env vars, queries). Row order *is* preserved across renames via the row-id-keyed serialization, which is what protects YAML diffs.
- **`x-telo-suggestions` autocomplete for keys.** A separate ergonomic enhancement that will route through MapField's key input once the suggestion infrastructure exists.
- **Bulk paste / "import as JSON" affordance.** Not needed for the current consumer set; a row-at-a-time editor is sufficient for the typical 1–10 entry maps these schemas produce.
- **Per-key custom validation messages** beyond `propertyNames.pattern`. The pattern's own error message is sufficient — the offending row is highlighted and the regex is shown in the tooltip.
- **Confirmation prompt on unmount with pending invalid rows.** Closing the detail panel, navigating between resources, or switching pointer selection while a MapField has a pending invalid row drops the in-progress key without a prompt. Adding a "you have unsaved invalid rows" guard would require routing dirty-state up through `ResourceSchemaForm` and into the navigation surfaces (panel close, resource switcher, pointer selector), which is a navigation-architecture change rather than a form-widget change. Deferred deliberately, not by oversight.
- **Run-execution gating on adapter form parse state.** `RunSettingsSection` currently exposes only a Recheck button; once Apply / Run controls are added, they should consume the same `onParseStateChange` pattern that `DetailPanel` adopts in this plan. Tracked as the follow-up the updated `AdapterConfigForm` docstring points at.
