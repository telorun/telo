---
"@telorun/type": minor
"@telorun/sdk": minor
"@telorun/analyzer": patch
---

Resolve `Type.JsonSchema` `extends` into a single self-contained object schema (a deep-merge of the parent schemas and the own schema) instead of an `allOf` wrapper, and expose the resolved schema as readable `schema` state on the Type instance.

The merge is now a single shared function, `mergeTypeSchemas` in `@telorun/sdk`, called by both the runtime `type` controller and the analyzer — so static analysis and runtime validation can never disagree on a type's effective shape. This fixes a false `CEL_UNKNOWN_FIELD` the analyzer raised when CEL accessed a field inherited through `extends` (it previously saw only a child type's own properties).

The merged form carries no `$ref`s, so a named type's effective shape is directly usable as a validation schema (e.g. an HTTP request body) without bundling, and it removes the `allOf` + `additionalProperties: false` footgun where each branch independently rejects the other branch's properties. `required` is unioned across all levels and child properties win on a key conflict. Composition keywords (`allOf` / `oneOf` / `anyOf`) declared on a parent or own schema are preserved as intersected `allOf` branches — never silently dropped — so an inherited constraint still applies.
