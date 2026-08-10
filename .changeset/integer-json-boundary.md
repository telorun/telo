---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/cli": minor
---

A CEL integer crosses a JSON boundary without a cast.

CEL models `int` as int64, which this runtime evaluates to a BigInt, and both doors out were shut. A JSON response body with no declared schema reached `JSON.stringify`, which throws on a BigInt; declaring the schema traded that for an AJV rejection (`must be integer` — its type check is `typeof data == "number"`) before the value was ever serialized. The only way through was `double(...)`, a cast that says "float" about a value that is an integer and silently truncates past 2^53 — and it had spread into the standard library's own examples, its docs, and the hub.

The kernel now installs `BigInt.prototype.toJSON` at `boot()` (`enableBigIntJson`, exported from `@telorun/kernel` — installing a global is a composition-root action, not something a controller should reach for), built on `JSON.rawJSON` so a BigInt serializes as its exact decimal digits rather than a lossy Number or a type-changing string. The rule is normative in `kernel/specs/invocation-contract.md` §4.4, so a second-language runtime has something to implement against. That is not a new policy: it is what `fast-json-stringify` already emitted for a schema-typed `integer`, so the runtime's two JSON serializers now agree at every magnitude instead of only below 2^53. Being a process-global patch — in the same spirit as the existing `process.env` guardrail — it covers every JSON boundary in the process: the kernel's, the standard library's, a third-party module's, and one not yet written.

The validator half moved with it. `ctx.validateSchema` and every `SchemaValidator.compile()` validator now check a BigInt-normalized view and merge the `useDefaults` fills back, so a computed integer satisfies a declared `integer` slot while the value that reaches the controller keeps its 64-bit range. That merge now recurses index-wise through arrays: AJV writes a default at every level it finds one, `items` included, and stopping at the array boundary dropped those fills silently. The contract binding no longer normalizes on its own — one layer owns the concern, and a contracted dispatch no longer walks its input and output trees twice.

Serializers that deliberately encode a BigInt differently were updated to keep doing so, since `toJSON` runs before a replacer: `encodeJsonValue` still tags one so a persisted value replays as the same type, the `json` log encoding still quotes a value beyond the safe range as OTLP does for its 64-bit fields, and the `pretty` console encoding still renders one as text. `bigIntAt` is exported from `@telorun/sdk` for a sink or codec that needs the same.
