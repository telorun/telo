# Stream element typing (`x-telo-stream: { items }`)

Give streams a **static element type** so the analyzer can reject wiring a
`Stream<A>` into a slot that expects `Stream<B>`, and (eventually) type the
elements a consumer iterates. Today every stream is element-opaque; this plan
makes the element type a first-class, optional part of the stream marker.

## Today

- `x-telo-stream: true` is a **boolean** — "this is a stream," no element type.
- The CEL environment registers **one** `Stream` type by constructor identity
  ([templating/nodejs/src/cel/environment.ts](../../../templating/nodejs/src/cel/environment.ts),
  `.registerType("Stream", Stream)`). So `Stream.Of`, `Ai.TextStream`,
  `S3.Get`, every codec output — all collapse to the same `Stream` CEL type.
- The only static rule is opacity: member access *past* a stream-marked
  property is a diagnostic
  ([templating/nodejs/src/cel/analyze.ts](../../../templating/nodejs/src/cel/analyze.ts)
  `validateChainAgainstSchema`).
- **No element comparison anywhere** — any stream is assignable into any
  `x-telo-stream` slot. `Stream<string>` flows into a record-stream consumer
  silently; the mismatch only surfaces at runtime when the consumer validates
  element shapes.

This is the gap: producers and consumers both "know" their element shape, but
the type system can't see it, so the wiring is unchecked.

## The form

Extend the marker to carry an optional element schema, with `true` as sugar for
"any element" (the CLAUDE.md-flagged evolution):

```yaml
output:
  x-telo-stream: { items: { type: string } }   # Stream<string>
# x-telo-stream: true   ≡   x-telo-stream: { items: {} }   (Stream<any>)
```

`true` stays valid and means `{ items: {} }` (any) — every existing producer
keeps working unchanged.

## Why it can't ride the CEL type registry

cel-js types values by **constructor identity** — there is one `Stream` class,
so `Stream<A>` and `Stream<B>` are indistinguishable to `registerType`. Element
typing therefore must be a **parallel structural check** carried *alongside* the
stream marker through the analyzer's schema plumbing, not a new CEL type. The
CEL `Stream` type stays as-is (one opaque runtime class); the element schema
lives in the JSON-Schema layer the analyzer already walks.

## Design

### 1. Schema + producers

- Allow `x-telo-stream` to be `boolean | { items: <JsonSchema> }`. Update
  `manifest-schemas.ts` / the `x-telo-*` validation so both forms pass.
- Producers opt in by declaring `items`:
  - `Stream.Of` — gains an optional `itemType: <JsonSchema>` field; its
    `outputType.output` becomes `x-telo-stream: { items: <itemType> }` (falling
    back to `true` when omitted). This makes `Stream.Of` the **reference
    producer** that first exercises the feature.
  - Codec `Encoder`/`Decoder`, `Ai.TextStream`, `S3.Get`, `Gzip.*`, `Tar.*`,
    the http-server stream body — migrate incrementally from `true` to a
    concrete `{ items }` where the element shape is known. None is required up
    front (gradual).

### 2. Analyzer — carry + compare

- **Carry**: wherever the analyzer resolves a stream-marked property's schema
  (step-context building, `inputType`/`outputType` typing, `x-telo-context`
  merges), preserve the `items` sub-schema rather than collapsing to a boolean.
- **Compare on assignment**: when a stream value flows into a stream-typed slot
  (`inputs: { input: "${{ steps.X.result.output }}" }`), structurally check the
  source `items` schema is assignable to the target `items` schema (JSON-Schema
  subtype/compatibility — reuse or extend the analyzer's existing schema-compat
  logic). Mismatch → a new `CEL_STREAM_ELEMENT_MISMATCH` diagnostic pointing at
  the offending wiring.
- **Gradual typing** (mirror the `x-telo-type` brand rule): `true` / `{ items:
  {} }` (any) is assignable both directions — a bare stream flows into a typed
  slot and vice versa. Only two *concrete, incompatible* element schemas
  conflict. This keeps every un-migrated producer/consumer working.
- **Opacity unchanged**: member access past a stream stays a diagnostic. Element
  typing governs *stream-to-stream assignment*, not reaching into a stream from
  CEL (CEL never iterates a stream).

Touch points: `templating/nodejs/src/cel/analyze.ts` (element-aware assignment +
the existing boundary check), `templating/nodejs/src/cel/environment.ts` (no
change to the `Stream` type itself), `analyzer/nodejs/src/validate-cel-context.ts`
/ `cel-environment.ts` (wire the comparison into context validation).

### 3. Editor / docs

- The editor reads schemas generically, so `x-telo-stream: { items }` needs no
  editor code — but a stream-typed field could surface its element type in the
  resource form for clarity (optional).
- Document the form in the CLAUDE.md `x-telo-*` section (replace the
  "today a boolean" note) and in `std/stream` docs.

## Backward compatibility

- `x-telo-stream: true` ≡ `{ items: {} }` — every current producer/consumer is
  an "any-element" stream and stays mutually assignable. No existing manifest
  changes behaviour; no diagnostic fires until a producer declares a concrete
  `items` *and* it's wired into a concrete, incompatible slot.

## Sequencing

1. Schema: accept `boolean | { items }`; normalize `true` → `{ items: {} }` in
   one place the analyzer reads.
2. Analyzer: carry `items` through context building; add the element-compat
   assignment check + `CEL_STREAM_ELEMENT_MISMATCH`; keep `true` gradual.
3. `Stream.Of` gains `itemType` and emits `{ items: itemType }` — the first
   typed producer; add positive + negative analyzer tests against it.
4. Migrate high-value producers/consumers to concrete `items` (codecs,
   `RecordStream`, `Ai.*`, `S3.Get`, gzip/tar) module-by-module, each with a
   changeset.
5. Update CLAUDE.md + docs.

## Testing

- Analyzer unit: `Stream<string>` into a `Stream<string>` slot passes;
  `Stream<string>` into a `Stream<{...}>` slot raises `CEL_STREAM_ELEMENT_MISMATCH`;
  `true` (any) into a typed slot and vice versa passes (gradual).
- Manifest: a `Stream.Of` with `itemType` wired correctly through a codec chain
  passes `telo check`; a deliberate mismatch fails.
- Regression: all existing stream manifests (opaque) still pass unchanged.

## Open questions

- **Schema-compat depth**: exact subtype rules for `items` (structural object
  compat, `enum`/`const` narrowing, `oneOf` element unions). Start strict-equal
  + "any is compatible," widen as needed.
- **Discriminated element unions** (the AI record shape: `{type: "text-delta"} |
  {type: "finish"} | …`) — express as `items: { oneOf: [...] }`; confirm the
  compat check handles a producer emitting a subset of a consumer's accepted
  variants.
- **`for await` typing inside `JS.Script`** — out of scope; CEL can't iterate
  streams, and JS.Script bodies are untyped. Element typing here is purely a
  manifest-level wiring check.
