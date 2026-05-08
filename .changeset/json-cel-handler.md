---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

Two additions to the shared CEL `Environment` used by the kernel runtime,
the loader, and the static analyzer:

**`json(value)` stdlib function.** Companion to the existing `sha256(string)`
handler. Accepts any `dyn` value (primitives, lists, maps, nested structures
sourced from step results) and returns a single-line JSON string. cel-js
parses `int` / `uint` literals as BigInt; the handler coerces them with
`Number(v)` unconditionally — values inside JS's safe range (±2^53)
round-trip cleanly, larger values lose precision. Telo manifests never carry
> 2^53 integer values in practice, so the simpler always-coerce contract
beats a value-dependent string fallback. Top-level `undefined` / function /
symbol values (which `JSON.stringify` would otherwise return as `undefined`,
violating the `json(dyn): string` signature) are coerced to `"null"`.

The first consumer is the registry MCP server, whose tool result blocks
need to package structured handler output into a single MCP `text` content
slot — e.g. `text: "${{ json(steps.search.result) }}"`. The function is
generally useful anywhere CEL needs to emit structured payloads as strings
(logging, hashing, transmission, debug output).

**`enableOptionalTypes: true` on the cel-js Environment.** Activates CEL's
optional-types syntax in every site that goes through the shared environment
(precompiled `${{ }}` template blocks). Available in any manifest from now
on:

- `value.?field` — optional field access; returns an `optional<T>` if the
  intermediate is missing instead of throwing.
- `list[?index]` — optional indexing; same semantics for arrays.
- `optional.orValue(default)` — unwrap with a fallback.
- `optional.hasValue()` / `optional.value()` — explicit checks.

This is a parser-level addition; the only existing-manifest hazard is using
`optional` as a variable name (now reserved). The first consumer is the
registry's `PublishHandler`, which uses
`steps.parseManifest.result.docs[?0].?metadata.?description.orValue(null)`
to safely extract the manifest's description across array indexing — a
chain `has()` cannot express because cel-js's `has()` macro rejects array
indexing in the path.
