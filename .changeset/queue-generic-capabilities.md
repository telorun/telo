---
"@telorun/sdk": minor
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

A controller asks for the zone its kind requires at the schema ROOT with the field-less `ctx.requireZone(ctx?)` / `ctx.findZone(ctx?)` — the same matching, correlation (a key crossing a `!ref` included) and `ERR_ZONE_REQUIRED` message as the field form — so a kind whose requirement is unconditional never raises the code itself. The controller protocol's `Zone.Require` / `Zone.Find` take the same lookup with no `field`.

A referrer rule may bind `coReferrers: /<slot>`: the other declarations of the `referrer:` kind reaching the same resource through that slot, each with its references resolved one level as `peers` resolves them — so a table refuses two stores claiming one name in it (`!coReferrers.exists(o, o.name == referrer.name)`) and nothing across tables. A pointer naming no reference slot of the referrer kind, or a rule without `referrer:`, is `REFERRER_RULE_INVALID`.

A literal at a union of encoded instance types (`anyOf: [Telo.Duration, Telo.Timestamp]`) is read by the one branch whose encoding reads it — `2s` a duration, RFC 3339 text a timestamp, an integer a duration in milliseconds — at every decode site, statically and at runtime alike.

`x-telo-retry-for: { slot: /<field>, codes? }` on a kind's retry-policy field relates it to the reference slot it re-attempts, so `telo check` judges its `nonRetryable` (`NON_RETRYABLE_CODE_NOT_THROWN`) and types `retryAfter`'s `error.data` against that slot's throws plus the codes the kind raises into the loop; a malformed annotation is `RETRY_FOR_INVALID`.

`x-telo-value-schema-from: /<ref>/outputType` (or `inputType`) reads the referenced resource's contract as a contract resolves — its own field, else the nearest declaration along its kind's `extends` — and a member read through such a node, or through any `allOf` of a document-local `$ref`, is judged, so a typo there is `CEL_UNKNOWN_FIELD`.

A `Telo.Duration` slot may bound its value: `x-telo-type: { name: Telo.Duration, minimum: 0s }`, and likewise `maximum`, `exclusiveMinimum` and `exclusiveMaximum`, each written as a duration or integer milliseconds. A literal outside a bound is refused by `telo check` at a resource's field and at a call's `inputs:`, and the kernel refuses the same value when the resource is created, a computed result after evaluation and a contract at dispatch, each naming the bound and the value (`must be a Telo.Duration at least 0s, not -1s`). The bound is data on the value type's entry (a parameter's `bound`), read by the Node and Rust SDKs alike. The shared retry policy's delays are bounded `minimum: 0s` and a step's `timeout:` `exclusiveMinimum: 0s`, replacing the dedicated `DURATION_OUT_OF_RANGE` check this release had introduced.

`x-telo-serializable: true` on a slot holding a shape (`x-telo-ref` with `use: schema`, or a JSON-Schema-valued field) says that shape's values are stored or serialized: a shape holding a `Telo.Stream` at any depth is refused by `telo check` (`SCHEMA_NOT_SERIALIZABLE`, naming the path) and when the resource is created (`ERR_SCHEMA_NOT_SERIALIZABLE`); a misplaced or malformed mark is `SERIALIZABLE_ANNOTATION_INVALID`. `DURABLE_UNJOURNALABLE_RESULT` now warns for a declared output holding a stream at any depth, not only at its root.

`ctx.traceCarrier(ctx?)` returns the current span as W3C Trace Context headers (`{ traceparent, tracestate? }`), or `undefined` when tracing is off: a controller records it with work it stores or sends, and `openSpan(…, { inbound: carrier })` continues it as that span's child, in its trace. The controller protocol gains `Span.Carrier`, and its generation moves to `9`.

A context binding typed by `x-telo-context-ref-from`, `-from-root` or `-from-ref-kind` keeps the nullability its own node declares (`type: [object, "null"]`), so an unguarded member read through it is `CEL_NULLABLE_ACCESS`.

`@telorun/sdk` exports the step engine's retry pieces for every holder that runs its own loop over the shared retry policy (a queue worker re-attempting a delivery): `isRetryable(err, nonRetryable?)` — false for a cancellation, a suspension, an ambient contract error, the kernel's verdicts on the call and a listed code — `retryMaxDelayMs(policy)`, `retryErrorView(err)` (the `error` a policy's CEL reads) and `retryAfterMs(policy, err, evaluate, { describe, data? })`, beside the already exported `retryBackoffMs`. The step engine's own retry loop calls the same functions.

A literal of an encoded value type inside an object typed by `x-telo-value-schema-from` (a timestamp, a duration as text or integer milliseconds, bytes, an unsigned integer) is decoded by the type its referenced shape declares, at a call's `inputs:` and at a config field, where it was refused. A member read through a union — `anyOf: [{ type: "null" }, …]` included — is judged against every alternative that can hold an object, so a typo there is `CEL_UNKNOWN_FIELD`, and a read through a union holding `null` without a guard is `CEL_NULLABLE_ACCESS`. A `Telo.Abstract` extending another module's abstract registers with its ancestors folded in its own scope, so a kind two modules down accepts the fields the root abstract declares at run as `telo check` already did.
