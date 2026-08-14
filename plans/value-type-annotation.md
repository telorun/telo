# One value-type annotation (`x-telo-type`)

**Prerequisite:** [manifest-migrations.md](./manifest-migrations.md). The legacy-spelling rewrite below is a migration entry, not a bespoke pass; `normalize-value-types` is that framework's first consumer.

## Problem

Three annotations answer one question — *what is the value at this slot, beyond what JSON Schema's `type` vocabulary can say?* — and each answers it differently:

- `x-telo-type: TcpPort` — a nominal brand over an integer; analyzer-only, closed table in `analyzer/nodejs/src/schema-compat.ts`.
- `x-telo-binary: true` — raw bytes; the only annotation that emits AJV validation code (`analyzer/nodejs/src/binary-slot.ts`).
- `x-telo-stream: true` — a live `Stream` handle; exempt from schema walks, opaque to CEL member access.

They differ in *posture* toward the JSON Schema layer — refine, replace, exempt — not in kind. Because each is spelled as its own keyword, adding a fourth edits eleven files across `sdk`, `templating`, `analyzer` and `kernel`, and three defects follow from the spread:

- **Silent degrade on a typo.** An unrecognized `x-telo-type` brand resolves to `undefined` and the slot quietly loses its identity — the failure `X_TELO_REF_INVALID_USE` exists to prevent for `use` tokens.
- **Bytes have no CEL identity.** `jsonSchemaToCelType` never consults `x-telo-binary`, so a byte-slot expression types as `dyn`.
- **A module string-matches the annotation.** `modules/http-server/nodejs/src/http-api-controller.ts` reads `x-telo-stream` by literal key, because a module may only import `@telorun/sdk` and there is nothing there to read — the same shape as the four surfaces that string-matched `x-telo-ref` before `ref-slot.ts`.
- **The analyzer hardcodes two tag names.** `substituteCelFields` branches on `INCLUDE_ENGINE_NAMES` / `INCLUDE_BYTES_ENGINE` to hand an `!include-bytes` a `Uint8Array` and an `!include-text` a `""`. That is the only place a tag's produced type is written down, and it is written in the consumer rather than the engine — the arrangement `fileClaims` already replaced for payload membership.

## Solution

**One annotation, `x-telo-type`, whose value is an alias-qualified type name or that name with parameters.** The three collapse into the best-named of them, with a generalized value grammar. One registry is the whole extension point: `sdk/nodejs/src/value-type.ts`, the sibling of `templating/nodejs/src/cel/catalog.ts`'s `CEL_FUNCTIONS` — one entry that both registers a type and documents it. It lives in the SDK because `Stream` already does, because the SDK is dependency-free and Node-built-in-free (so the analyzer stays browser-safe — templating already imports it as a value), and because it is the only placement a module controller can reach.

An entry declares **how the value is represented**, and every consumer derives its own fact. The whole starting vocabulary, with the derived columns showing what an entry never has to write:

| entry | representation *(declared)* | parameters *(declared)* | AJV does | CEL sees | placeholder |
| --- | --- | --- | --- | --- | --- |
| `Telo.TcpPort`, `Telo.UdpPort` | `json` over `integer` | none | nothing — the declared schema validates | a field-less brand, matched by name | the base type's |
| `Telo.Bytes` | `instance` of `Uint8Array` | none | asserts the constructor | the native `bytes` type | an empty `Uint8Array` |
| `Telo.Stream` | `instance` of `Stream`, `live` | `of`, defaulting to *any* | nothing, at any position — the slot is exempt | the registered `Stream` class, opaque to member access | none; nothing is validated |

A `json` representation is an ordinary value its declared schema already validates, the name adding nominal identity for static wiring. An `instance` is not JSON at all, which is what makes bytes unauthorable — no YAML literal is ever a `Uint8Array`. `live` marks an instance whose consumption has effects, so it is exempt from validation rather than asserted. Base type, opacity, the AJV assertion, the placeholder and the CEL registration all fall out of those fields, so no code fragment crosses a package boundary: the analyzer's keyword emits an `instanceof` check from `representation`, and `live` decides assert-versus-exempt. Accessors follow the `ref-slot.ts` / `zone-slot.ts` precedent — one reader, no consumer pattern-matching the shape again. The exemption becomes a property of the *type* — applied wherever a schema is compiled or a value substituted, not only in the contract binding as today, and wherever the type *appears*. `stripStreams` already recurses into `items` and the union branches, but it only neutralizes a key it found in a `properties` map, so an array-of-streams element is reached and left constrained. Once exemption belongs to the type, an item and a branch are the same case as a property.

**A type is named the way everything else in Telo is named.** Naming a type currently has three unrelated grammars — a bare brand from a kernel table, a `telo://` URI in a `$ref`, and the four forms `resolveTypeFieldToSchema` accepts on a contract field — while every other cross-boundary name uses one: alias-qualified, resolved in the declaring module's scope (`kind:`, `extends:`, `x-telo-ref.kind`, `x-telo-requires-zone`, `!ref`). `x-telo-type` adopts it. A name resolves over a **union of two things that are both a named type**: built-in value types under the auto-registered `Telo.` alias, and named `Telo.JsonSchema` resources under any alias — `Telo.Stream`, `Self.File`, `Ai.ImageResult`. Not through `resolveKind`, since nothing instantiates a value type, but sharing the grammar and the alias scope, which is what consistency means here. A plain JSON Schema stays legal wherever a name is, because an inline shape is the common case and JSON Schema already names the primitives; a `Telo.String` would be the wrong kind of completeness. Resolution reuses `resolveSchemaRefKinds`, which already canonicalizes `x-telo-ref.kind` in the declaring scope before registration — and must, for a sharp reason: this annotation is in the kernel's compiled-validator cache key, so an un-canonicalized `Self.File` at runtime against a canonical `mod.File` in the analyzer's baked view is exactly the key-drift that annotation already documents.

**Legacy spellings are erased at load, not carried into the analyzer.** A `normalize-value-types` **migration entry** rewrites `x-telo-stream: true` to `x-telo-type: Telo.Stream`, `x-telo-binary: true` to `Telo.Bytes`, and an unqualified brand such as `TcpPort` to `Telo.TcpPort`, emitting `X_TELO_TYPE_DEPRECATED`. Each is a key rename, so none carries an editor quick fix — the diagnostic says so and points at `telo migrate`, which applies them. Everything else about it — the loader phase, rewriting always but reporting only for the entry's own modules, path provenance, the editor gate and `telo migrate` — belongs to the migration framework and is not restated here. The kernel consumes the analyzer's loader, so one rewrite serves `telo check`, the runtime, the definition registry and the editor alike; nothing downstream knows the old vocabulary exists, and retiring it is deleting one entry and two `legacy` fields.

**`!include-bytes` fills a `Bytes` slot, and the engine is what says so.** A `TemplatingEngine` gains a declared produced type, expressed as a schema fragment: `!include-bytes` declares `x-telo-type: Telo.Bytes`, `!include-text` declares `type: string`. `substituteCelFields` substitutes that fragment's placeholder and loses its tag-name branch entirely. The property CLAUDE.md records — an embed's type is a constant of the tag, not a function of the slot, so a byte embed at a string slot and text at a byte slot both fail statically *with no new diagnostic code* — is preserved exactly, because the placeholder is still a real `Uint8Array` and the registry's keyword is still what rejects it. What changes is that a future tag producing bytes declares it rather than being added to a set. This is also the arm of the design with no CEL in it anywhere: `kernel/rust` resolves an embed into a slot typed by this registry, in a kernel that has no CEL engine.

**Value types are generic.** A registry entry declares named **type parameters**; the annotation's object form supplies **type arguments**. `Telo.Stream` declares one, `of` — so a byte stream is `{ name: Telo.Stream, of: Telo.Bytes }`, and a record stream supplies a shape instead. A type argument is itself a schema node, which is what makes the system compose with no new grammar: an argument may be a plain JSON Schema, an alias-qualified name (sugar for a node carrying only `x-telo-type`, so `of: Self.File` and a `$ref` to the same shape mean one thing), or another parameterized type, nesting to any depth. Every parameter is optional and defaults to *any*, so an unparameterized `Stream` stays legal.

Arguments are compared with the analyzer's existing `checkSchemaCompatibility` — conservative, flagging only definite mismatches — extended to recurse through `items` and through a nested `x-telo-type` argument. That extension is load-bearing rather than incidental: today the function compares `type` and descends only into an `object`'s properties, so a stream of arrays of strings and a stream of arrays of integers both read as `array` and pass, leaving argument checking inert on exactly the nested shapes. It must also resolve a named argument — whether written as `Self.File` or as the `$ref` it canonicalizes to — before comparing: declaring a shape once and referencing it is the sanctioned way to reuse one, and two such arguments would otherwise present as opaque nodes carrying no information. `withStreamPropertiesSkipped` already takes a `resolveRef` for the same reason. The comparison is **covariant**, since a stream is consumed by reading: a stream of a narrower element satisfies a slot declaring a wider one, and a definite conflict is `CEL_TYPE_ARGUMENT_MISMATCH`. This subsumes `analyzer/nodejs/plans/stream-element-typing.md`, whose `items` becomes `of`. `Stream.Of` gains an `itemType` field as the reference producer, and the producers whose element shape is genuinely known migrate with it (`codec`, `record-stream`, `ai`, `tar`, `gzip`, `shell`, `console`, `http-server`) — a check nothing declares against is inert.

Two cleanups ride along because the unification exposes them. `registerTeloKeywords` replaces five drifted AJV registration sites — `analyzer`'s `createAjv` and the kernel's `schema-validator`, `resource-context`, `observed-state` and `manifest-schemas`, which today register overlapping keyword lists of twelve, four, one and one. And `telo cel types` plus a generated section in `docs/cel-reference.md` mirror `telo cel functions`, so the closed vocabulary documents itself from the same entry that defines it.

Touch points: `sdk/nodejs/src/value-type.ts` (registry + accessors), `analyzer/nodejs/src/value-type-keyword.ts` (AJV codegen, `registerTeloKeywords`), `analyzer/nodejs/src/migrations/normalize-value-types.ts` (one migration entry), `analyzer/nodejs/src/validate-value-type-slots.ts` (diagnostics), `analyzer/nodejs/src/resolve-schema-ref-kinds.ts` (name canonicalization), and read-side edits collapsing the hardcoded keywords in `schema-compat.ts`, `cel-environment.ts`, `invocation-contract.ts`, `templating/nodejs/src/cel/{environment,analyze}.ts`, `templating/nodejs/src/{engine,engines/include}.ts` (the declared produced type, mirrored in `templating/rust/src/engines/include.rs`), `kernel/nodejs/src/{schema-validator,resource-context,observed-state,manifest-schemas,invocation-contract-binding}.ts` and `modules/http-server/nodejs/src/http-api-controller.ts`.

## Decisions

- **The keyword is `x-telo-type`.** Every other `x-telo-*` annotation names something JSON Schema has no counterpart for; this one *is* the `type` keyword extended, and it always sits adjacent to `type:` — an adjacency that teaches the concept on sight. Inside a schema node the word is unclaimed except by JSON Schema itself. Rejected: `x-telo-cel-type`, which names one reader of the annotation and would be a lie at the AJV, literal-authorability and polyglot boundaries (`kernel/rust` resolves `!include-bytes` with no CEL at all); `x-telo-runtime-type`, which excludes the brands, whose whole point is having no runtime existence; `x-telo-value-type`, accurate but signalling value-versus-reference semantics to a systems reader, exactly backwards for `Stream` and `Bytes`. The accepted cost is sharing the word with `inputType` / `outputType` / `Telo.Type`, which name shapes — complementary halves of one vocabulary, never at the same nesting level.
- **The keyword is short; the concept noun and API stay qualified.** `x-telo-type` in manifests, "value type" in docs, `value-type.ts` for the registry — a schema node gives the keyword its disambiguating context and prose has none. The same split `ref-slot.ts` already has against `x-telo-ref`.
- **Registry in the SDK, AJV codegen in the analyzer.** The SDK cannot depend on ajv; declaring a *representation* rather than a code fragment keeps the split clean and keeps the entry the single place a type is defined. Rejected: an analyzer-side assertion map keyed by name, which would reintroduce a second place to edit.
- **Rewrite at load, not at schema-compile time, and as a migration entry rather than a bespoke pass.** `normalizeRefSlots` normalizes legacy ref slots at every compile site instead, which means every reader must keep the legacy knowledge. Rewriting once at load is what lets the old vocabulary be deleted in one place; expressing it as an entry is what gives the author `telo migrate` instead of prose, and what makes the same rewrite happen on both kernels. See `plans/manifest-migrations.md`.
- **Names are alias-qualified, resolving over built-ins and named shapes alike.** One grammar for naming a type instead of three, and the one every other cross-boundary name already uses. Rejected: keeping the bare-brand form, which cannot express a module-declared type and leaves `telo://` URIs as a second spelling with a different scope rule (module names, not aliases).
- **Shapes are open; representations are closed.** A module can name its own type — as a `Telo.JsonSchema` shape, which is what YAML can express. It cannot define a representation, which needs a constructor and an assertion, i.e. code. That is the joint the vocabulary is cut at, and it is a better line than deferring openness: the case authors actually need is available immediately, and the case that needs a delivery story stays kernel-owned until one exists.
- **A type argument is a schema node, not a new grammar.** An argument may be a JSON Schema, an alias-qualified name, or a parameterized type, and it nests to any depth because the recursion is JSON Schema's own. Rejected: an angle-bracket string syntax, which reads well for a named element and falls over the moment the element is an inline shape — the common case for record streams.
- **Named type parameters, not positional arguments.** `of` names itself in a diagnostic and lets a future two-parameter type add a second name without a migration; a positional list would report "argument 0" and fix arity into the syntax.
- **The argument lives inside the annotation, not in a native `items` beside it.** The symmetry is tempting — `type: array` pairs with `items`, so `x-telo-type: Stream` might too — but `analyzer/nodejs/src/schema-compat.ts`'s `navigateSchemaToExprPath` resolves `[N]` access by stepping through `items`, so an element schema there makes a stream slot indexable and hands out an element type at exactly the access the opacity rule forbids: two rules, one question, different answers. It also degrades the wrong way. `x-telo-binary`'s graceful degradation is safe because an unaware reader sees *unconstrained* — weaker than the truth; `items` on a stream reads as "every element is a string, and checkable", stronger than anything the runtime can enforce, since iterating a stream to validate it is precisely what the exemption forbids. Keeping them separate also leaves `items` free to mean what it always meant on a value type whose base really is an array.
- **`checkSchemaCompatibility` is extended, not replaced.** It is already the conservative structural comparison this needs, and it has no callers anywhere in the repo today, so tightening it to recurse through `items` and nested arguments carries no regression risk. Rejected: a second argument-specific comparator, which would have to agree with the first forever.
- **Arguments are covariant and gradual.** A stream is consumed by reading, so a narrower element satisfies a wider slot; an omitted argument is *any* in both directions, which is what keeps every unmigrated producer and consumer checking exactly as it does today.
- **Type arguments live in the schema layer and are erased at the CEL boundary.** cel-js types values by constructor identity, so a byte stream and a string stream are one CEL type and always will be. The argument check is a parallel structural pass over schemas the analyzer already walks. Rejected: registering a CEL type per instantiation, which the engine cannot express.
- **An unresolvable name is a hard error, split by cause.** `X_TELO_TYPE_UNRESOLVED` when the alias or the name behind it resolves to nothing (mirroring `X_TELO_REF_UNRESOLVED`), `X_TELO_TYPE_UNKNOWN` when a `Telo.`-qualified name is not a built-in, both Levenshtein-suggested and scoped to the entry's own modules — a published dependency is not the consumer's to fix. This tightens `x-telo-type` itself, which today ignores an unrecognized brand silently. An argument naming a parameter the type does not declare is `X_TELO_TYPE_ARGUMENT_UNKNOWN` on the same terms.
- **The deprecation is a warning, scoped to the entry's own modules**, so an app importing an unmigrated standard-library module sees no noise. The `X_TELO_REF_LEGACY_IDENTITY` precedent.
- **No spelling migration of standard-library manifests.** The rewriter makes them canonical at load; churning twelve modules to change a keyword would republish artifacts whose behaviour did not move.
- **`x-telo-type` is a validating annotation**, so it survives `stripTeloAnnotations` and stays in the compiled-validator cache key — which is precisely why its names must be canonicalized at registration, exactly as `x-telo-ref.kind`'s are. An alias-qualified name left un-rewritten would make the analyzer's baked view and the runtime's hash differently and miss the cache on every boot, the failure that annotation already documents.
- **A tag's produced type is declared by its engine, never recognised by its consumer.** The `fileClaims` precedent, applied to the one fact it left behind. Rejected: comparing an engine's produced type against the slot's and raising a dedicated diagnostic — the placeholder already fails AJV with an accurate message in both directions, and a second rule would have to agree with the first forever.
- **`celTypeSatisfiesJsonSchema` gains acceptance, never loses it.** The existing `bytes` row stays; `Bytes` adds a case rather than tightening an old one, so no manifest that checks today stops checking.

## Example after the change

```yaml
# a nominal refinement — the declared JSON type still does the validating
port:
  type: integer
  x-telo-type: Telo.TcpPort
  minimum: 1
  maximum: 65535

# not JSON at all — no literal can be written here, and AJV asserts the bytes
content:
  x-telo-type: Telo.Bytes

# a live handle, parameterized by a named value type — what every codec encoder
# produces, and today only prose in its `description`
output:
  x-telo-type: { name: Telo.Stream, of: Telo.Bytes }

# the same type, its argument an ordinary schema instead of a name
records:
  x-telo-type:
    name: Telo.Stream
    of:
      type: object
      properties:
        line: { type: string }
      required: [line]

# arrays and value types interleave, because an argument is just a schema node —
# a real array whose elements are bytes, validated element by element
attachments:
  type: array
  items:
    x-telo-type: Telo.Bytes

# a stream whose element is an array
batches:
  x-telo-type:
    name: Telo.Stream
    of:
      type: array
      items: { type: string }

# and it nests to any depth, in either direction
uploads:
  x-telo-type:
    name: Telo.Stream
    of:
      x-telo-type: { name: Telo.Stream, of: Telo.Bytes }
```

A composite like a file is a **shape**, not a value type — only its bytes leaf is one — so it is declared the way any shape is, and reused by reference:

```yaml
kind: Telo.JsonSchema
metadata: { name: File }
schema:
  type: object
  required: [filename, mimeType, content]
  properties:
    filename: { type: string }
    mimeType: { type: string }
    content: { x-telo-type: Telo.Bytes }
```

A multipart upload is then a stream of them — `x-telo-type: { name: Telo.Stream, of: Self.File }` — the same grammar naming a built-in type and a module's own, differing only in which alias resolves it. `modules/ai`'s `ImageResult` is already this shape.

Filling that byte slot, in a manifest — the embed is the only way in, since no YAML literal is ever bytes:

```yaml
- kind: Fs.Write
  metadata: { name: seedIcon }
  path: ./out/icon.png
  content: !include-bytes ./assets/icon.png
```

Writing `!include-text` there instead fails `telo check`, because the tag produces a string and the slot's declared type is `Telo.Bytes` — the same rule, read from the same registry, that rejects a plain YAML string at the slot.

Wiring that `output` into a consumer declaring `of: { type: string }` is `CEL_TYPE_ARGUMENT_MISMATCH`; wiring it into one declaring a bare `Telo.Stream` passes, because an omitted argument is *any*. Adding a fourth value type — parameterized or not — is one entry in `sdk/nodejs/src/value-type.ts`.
