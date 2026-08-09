---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Add `x-telo-binary: true` — a declared identity for schema slots carrying raw bytes.

Bytes have no JSON Schema type. `type: object` was the closest fit and it costs a real check: every object satisfies it, so a mistyped literal at a byte slot passed `telo check` and failed inside the controller. `type: binary` is not an alternative — AJV refuses to *compile* an unknown type, with no setting to allow it, and a published `telo.yaml` would stop being JSON Schema for the hub, the editor and any third-party reader. An `x-` keyword is ignored by unaware tooling by specification, so it degrades to "unconstrained" instead of "cannot validate this kind at all".

The accessor and the AJV keyword live in `analyzer/nodejs/src/binary-slot.ts` (browser-safe), registered by the analyzer's `createAjv()` and by every kernel AJV site. Three details are load-bearing: the keyword is AJV **codegen** rather than a `validate` function, so it inlines into the standalone validators the kernel compiles and caches; `celPlaceholderForSchema` hands a CEL leaf at a byte slot a real `Uint8Array`, so the static and runtime rules are one rule rather than two kept in step; and it is exempt from `stripTeloAnnotations`, whose premise was that no annotation affects the validator — stripping it would silently reduce the slot to an empty schema.

What this buys is a check no JSON Schema type expresses: **bytes always arrive by reference**, so an inline literal at such a slot is rejected statically, and a non-byte value from a CEL expression is rejected by the input contract at dispatch instead of reaching a controller.

Note for schema authors: a union with a byte branch must use `anyOf`, never `oneOf`. A consumer that does not know the keyword reads the branch as an empty schema matching everything, so under `oneOf` a plain string would match both branches and fail.
