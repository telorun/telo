# One value-type annotation (`x-telo-type`)

**Prerequisite:** [manifest-migrations.md](./manifest-migrations.md). The legacy-spelling rewrite below is a migration entry, not a bespoke pass — and it is the entry that forces one extension to that framework's selector vocabulary, specified here because the framework has landed: a **schema region** (see *Legacy spellings*).

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

**One annotation, `x-telo-type`, whose value is a built-in type name or that name with type arguments.** The three collapse into the best-named of them, with a generalized value grammar.

**The vocabulary is DATA; the binding to a language is not.** A type entry is one JSON file under `sdk/value-types/`, read as one lexically ordered set — the `analyzer/migrations/` arrangement, for the same reason and with the same mechanics: the files sit beside the language halves rather than inside either, `scripts/copy-value-type-entries.mjs` (an SDK `prepare` step) copies them in and emits the barrel from the same directory listing, and Rust embeds them with `include_str!`. This matters more here than it looks. The Rust half genuinely needs the vocabulary — `!include-bytes` declares that it produces `Telo.Bytes` in `templating/rust`, and `kernel/rust` resolves that embed into a slot typed by this registry, in a kernel with no CEL engine — so a registry written as Node code would be a second registry, hand-copied, drifting silently exactly as a predicate expressed in one language would.

An entry declares **how the value is represented** and nothing about any runtime:

- `name` — `Telo.Bytes`. Qualified because the vocabulary is closed and kernel-owned; see *Decisions*.
- `representation` — `json` (an ordinary value, plus a `base` JSON type) or `instance` (not JSON at all).
- `binding` — for an `instance`, a stable symbolic key (`bytes`, `stream`). Never a constructor name, which is a fact about one language.
- `live` — an instance whose consumption has effects, so it is exempt from validation rather than asserted.
- `parameters` — named type parameters, each optional and defaulting to *any*.
- `description` — what `telo cel types` and the generated docs section print.

**A per-language binding table maps `binding` → that runtime's identity**: `sdk/nodejs/src/value-type.ts` maps `bytes` → `Uint8Array` and `stream` → `Stream`, `sdk/rust/src/value_type.rs` maps them to its own. A `binding` with no row in the host's table is a **hard startup error**, never a skipped assertion — a type that cannot be asserted would silently exempt every slot that declares it, which is the failure this whole design exists to make impossible. The table is the only per-language artifact; adding a type is one JSON file plus one row per runtime that can represent it.

The starting vocabulary, with the derived columns showing what an entry never has to write:

| entry | representation *(declared)* | parameters *(declared)* | AJV does | CEL sees | placeholder |
| --- | --- | --- | --- | --- | --- |
| `Telo.TcpPort`, `Telo.UdpPort` | `json` over `integer` | none | nothing — the declared schema validates | a field-less brand, matched by name | the base type's |
| `Telo.Bytes` | `instance`, binding `bytes` | none | asserts the bound identity | the native `bytes` type | an empty `Uint8Array` |
| `Telo.Stream` | `instance`, binding `stream`, `live` | `of`, defaulting to *any* | nothing, at any position — the slot is exempt | the registered `Stream` class, opaque to member access | none; nothing is validated |

A `json` representation is an ordinary value its declared schema already validates, the name adding nominal identity for static wiring. An `instance` is not JSON at all, which is what makes bytes unauthorable — no YAML literal is ever a `Uint8Array`. Base type, opacity, the AJV assertion, the placeholder and the CEL registration all fall out of those fields, so no code fragment crosses a package boundary: the analyzer's keyword emits an `instanceof` check against whatever the host's binding table names, and `live` decides assert-versus-exempt. Accessors follow the `ref-slot.ts` / `zone-slot.ts` precedent — one reader, no consumer pattern-matching the shape again. The exemption becomes a property of the *type* — applied wherever a schema is compiled or a value substituted, not only in the contract binding as today, and wherever the type *appears*. `stripStreams` already recurses into `items` and the union branches, but it only neutralizes a key it found in a `properties` map, so an array-of-streams element is reached and left constrained. Once exemption belongs to the type, an item and a branch are the same case as a property.

**Exemption is from VALIDATION, never from TYPING.** A `live` type's slot is not walked by AJV and its value is never traversed — that is the whole point, since iterating a stream to check it is what the exemption forbids. Its declared argument still travels through every schema-*typing* walk the analyzer performs, because that is where the argument check reads it. Conflating the two would delete the information the check needs at the moment it is generalized, and the generalization above must be read with this line attached to it.

**A type NAME is a built-in; a SHAPE is named with `!ref`, like every other named thing.** Naming a type currently has three unrelated grammars — a bare brand from a kernel table, a `telo://<Alias>/<Type>` URI in a `$ref`, and the four forms `resolveTypeFieldToSchema` accepts on a contract field. This collapses them onto the two Telo already has, along the line the vocabulary is actually cut at:

- The **name slot** takes only a `Telo.`-qualified built-in — a closed set, so there is no alias scope, no resolution and no gate. `Telo.Stream`, `Telo.Bytes`, `Telo.TcpPort`. An unknown name is `X_TELO_TYPE_UNKNOWN`, Levenshtein-suggested; a name is never module-defined, because a representation needs code (see *Decisions*).
- An **argument** is a schema node, so a named shape is reached the one way a named resource is ever reached: `of: !ref File`, `of: !ref Ai.ImageResult`. `use: schema` is already in the `x-telo-ref` vocabulary for exactly this relation — *names a shape; no runtime instance, no edge* — so the reference model was built to carry shape references and this is it being used. A dotted bare string is deliberately **not** accepted: `{ kind, name }` and bare-string references were removed precisely so a reference has one spelling, and a dotted string beside `x-telo-ref: Sql.Connection` in the same schema node would be the same syntax over a different namespace, with nothing to tell a reader or a resolver which was meant.

**`!ref` is the authoring surface; `$ref: "telo://<module>/<Type>"` becomes the canonical INTERNAL form.** The loader normalizes one into the other — a normalization, not a migration, and the same shape `resolveRefSentinels` already has for resource refs and `resolveSchemaRefKinds` for alias-qualified kinds. That split is what keeps both halves honest, and neither half is optional:

- Authors and the editor see one reference grammar and one tag. **`analyzer/rust` already resolves `!ref` sentinels** and has no `telo://` resolver, so the tag is the *cheaper* polyglot path, not the dearer one — and the reference picker, go-to-definition and reference validation come from machinery that already exists rather than from a second alias resolver with its own two diagnostics.
- Validators keep seeing a **reference**, not an inlined copy. The runtime deliberately preserves the `$ref` form today (`withStreamPropertiesSkipped` documents why it must follow one rather than substitute it): inlining changes schema identity, and the compiled-validator cache is keyed on it. Preserving the reference is also what leaves a self-recursive shape expressible at all, and it is not a Node concern — any runtime's validator wants a registered `$id` rather than an expanded tree.

Two consequences are work this plan owns rather than machinery it inherits, and both must land with it. `resolveTypeFieldToSchema` must become **alias-aware**: today it reads a resolved ref's `name` and matches by bare `metadata.name` over the flattened list, ignoring `alias` entirely, so `!ref Ai.ImageResult` and `!ref ImageResult` resolve identically and two libraries declaring a same-named shape collide silently. And whether a `Telo.Type` reached across an import boundary is **gated** needs an answer: it is `capability: Telo.Type` — no runtime instance — so `exports.resources` does not cover it and nothing gates it under either spelling today. Deciding it is in scope here; inheriting a gate that does not exist is not.

A plain JSON Schema stays legal wherever an argument is, because an inline shape is the common case and JSON Schema already names the primitives; a `Telo.String` would be the wrong kind of completeness.

**Legacy spellings are erased at load, not carried into the analyzer.** A `normalize-value-types` **migration entry** rewrites `x-telo-stream: true` to `x-telo-type: Telo.Stream`, `x-telo-binary: true` to `Telo.Bytes`, and an unqualified brand such as `TcpPort` to `Telo.TcpPort`, emitting `X_TELO_TYPE_DEPRECATED`. Each is a key rename, so none carries an editor quick fix — the diagnostic says so and points at `telo migrate`, which applies them.

Reaching every occurrence needs **one extension to the selector vocabulary, and it is the extension this rewrite proves is missing**. These annotations do not live only in kind documents: they occur in author-written schema fragments inside *ordinary resource documents* — an inline `inputType:` / `outputType:` on any kind that declares one, an `Http.Api` route's `request.schema.body`, a `Telo.JsonSchema`'s `schema`. That set of kinds is open, and enumerating it in `inKind` would put resource-kind knowledge into the analyzer, against the topology-driven constraint. So `match` gains a **schema region**:

- **`inSchema: true`** — the match must be at or below a node reached through one of the **kernel's own schema-valued manifest keys** (`schema`, `status`, `inputType`, `outputType`, `itemType`). Those key names are kernel vocabulary, not any kind's, which is what keeps this generic: the driver learns no resource kind, and a module that invents a schema-bearing field of its own reaches it through one of these or not at all.
- **`inKind: ["*"]` / `under: ["*"]`** — legal *only* together with `inSchema`, and *only* for a rule whose `key` begins with `x-telo-`, both refused at entry-read time. That pairing is the containment: the region gate bounds where the walk may go, and the reserved-key rule bounds what it may touch — an `x-telo-*` key is Telo vocabulary wherever it appears, so unlike a rule keyed on `type:` it cannot mean something else in someone's config.
- `notUnder` keeps subtracting the data-bearing JSON Schema keywords (`const`, `default`, `enum`, `examples`) within the region.

**The cost is a wrong-rewrite residue, and it is not a performance one.** The wildcard forms do drop the walk's bounding property — a document no rule targets is no longer skipped — but at Telo's scale that is a handful of manifests of a few thousand nodes each, so the walk is not worth pricing and this plan does not pretend otherwise. What the forms genuinely cost is one shape the gate admits wrongly: a manifest that asserts *about* a schema — a schema literal written under a key spelled `schema` inside an assertion's expected value — is reachable, and would be rewritten to the current spelling, changing what is asserted. That cannot be closed inside a data-only matcher without naming kinds. It is accepted because the alternative is worse in kind rather than in degree: the sites the wildcards reach are the ones no enumeration could ever cover, and leaving them unmigrated means an author is told to fix a spelling `telo migrate` refuses to touch.

Everything else about the rewrite — the loader phase, rewriting always but reporting only for the entry's own modules, path provenance, the editor gate and `telo migrate` — belongs to the migration framework and is not restated here. The kernel consumes the analyzer's loader, so one rewrite serves `telo check`, the runtime, the definition registry and the editor alike; nothing downstream knows the old vocabulary exists, and retiring it is deleting one entry and two `legacy` fields.

**`!include-bytes` fills a `Bytes` slot, and the engine is what says so.** A `TemplatingEngine` gains a declared produced type, expressed as a schema fragment: `!include-bytes` declares `x-telo-type: Telo.Bytes`, `!include-text` declares `type: string`. `substituteCelFields` substitutes that fragment's placeholder and loses its tag-name branch entirely. The property CLAUDE.md records — an embed's type is a constant of the tag, not a function of the slot, so a byte embed at a string slot and text at a byte slot both fail statically *with no new diagnostic code* — is preserved exactly, because the placeholder is still a real `Uint8Array` and the registry's keyword is still what rejects it. What changes is that a future tag producing bytes declares it rather than being added to a set. This is also the arm of the design with no CEL in it anywhere, and the arm that makes the data vocabulary load-bearing: `kernel/rust` resolves an embed into a slot typed by the same entries, read from the same files.

**Value types are generic.** A registry entry declares named **type parameters**; the annotation's object form supplies **type arguments**. `Telo.Stream` declares one, `of` — so a byte stream is `{ name: Telo.Stream, of: Telo.Bytes }`, and a record stream supplies a shape instead. A type argument is itself a schema node, which is what makes the system compose with no new grammar: an argument may be a plain JSON Schema, a built-in type name, a `!ref` to a named shape, or another parameterized type, nesting to any depth. Every parameter is optional and defaults to *any*, so an unparameterized `Stream` stays legal.

**The check runs on the CEL wiring path**, which is the one place a produced value's schema meets a consuming slot's: a stream flows from a producer into a slot as an expression (`inputs: { input: !cel "steps.encode.result.output" }`), so the compared pair is the **producer's `outputType` navigated to the expression's tail** against **the slot's declared argument** — the site `analyzer/nodejs/plans/stream-element-typing.md` named, in `templating/nodejs/src/cel/analyze.ts`'s chain validation, wired through the analyzer's context typing. Naming it is not a detail: the same annotation is read by AJV, by the include arm and by the Rust kernel, none of which compare arguments, and only this one does. The `CEL_` prefix on the diagnostic follows from the site.

The comparator is **new code written where the dead one lives**, and the plan says so rather than calling it an extension. `checkSchemaCompatibility` has no callers, is not exported from the analyzer's index, and compares only `type` for the names in `target.required`, recursing into objects — it treats `anyOf` / `oneOf` as compatible and never looks at `items` or `$ref`. So there is no regression risk, but there is also nothing to lean on: what survives is its posture — conservative, flagging only definite mismatches — while the traversal (through `items`, through a nested `x-telo-type` argument, through a resolved `!ref`) is written. Resolving a `!ref` argument before comparing is required, not optional: declaring a shape once and referencing it is the sanctioned way to reuse one, and two such arguments would otherwise present as opaque nodes carrying no information. `withStreamPropertiesSkipped` already takes a `resolveRef` for the same reason. The comparison is **covariant**, since a stream is consumed by reading: a stream of a narrower element satisfies a slot declaring a wider one, and a definite conflict is `CEL_TYPE_ARGUMENT_MISMATCH`. This subsumes the stream-element-typing plan, whose `items` becomes `of`. `Stream.Of` gains an `itemType` field as the reference producer, and the producers whose element shape is genuinely known migrate with it (`codec`, `record-stream`, `ai`, `tar`, `gzip`, `shell`, `console`, `http-server`) — a check nothing declares against is inert.

Two cleanups ride along because the unification exposes them. `registerTeloKeywords` replaces five drifted AJV registration sites — `analyzer`'s `createAjv` and the kernel's `schema-validator`, `resource-context`, `observed-state` and `manifest-schemas`, which today register overlapping keyword lists of twelve, four, one and one. And `telo cel types` plus a generated section in `docs/cel-reference.md` mirror `telo cel functions`, so the closed vocabulary documents itself from the same entries that define it.

Touch points: `sdk/value-types/*.json` (the entries), `scripts/copy-value-type-entries.mjs`, `sdk/nodejs/src/value-type.ts` (reader, accessors, Node binding table), `sdk/rust/src/value_type.rs` (Rust reader + binding table), `analyzer/nodejs/src/value-type-keyword.ts` (AJV codegen, `registerTeloKeywords`), `analyzer/nodejs/src/migrations/{match,entry-data}.ts` (the schema-region vocabulary) plus `analyzer/migrations/normalize-value-types.json` (one entry), `analyzer/nodejs/src/validate-value-type-slots.ts` (diagnostics), `analyzer/nodejs/src/validate-cel-context.ts` (`resolveTypeFieldToSchema` becomes alias-aware), `analyzer/nodejs/src/resolve-schema-type-refs.ts` (`!ref` → canonical `telo://<module>/<Type>` normalization, replacing the authoring-side URI), and read-side edits collapsing the hardcoded keywords in `schema-compat.ts`, `cel-environment.ts`, `invocation-contract.ts`, `templating/nodejs/src/cel/{environment,analyze}.ts`, `templating/nodejs/src/{engine,engines/include}.ts` (the declared produced type, mirrored in `templating/rust/src/engines/include.rs`), `kernel/nodejs/src/{schema-validator,resource-context,observed-state,manifest-schemas,invocation-contract-binding}.ts` and `modules/http-server/nodejs/src/http-api-controller.ts`.

## Decisions

- **The keyword is `x-telo-type`.** Every other `x-telo-*` annotation names something JSON Schema has no counterpart for; this one *is* the `type` keyword extended, and it always sits adjacent to `type:` — an adjacency that teaches the concept on sight. Inside a schema node the word is unclaimed except by JSON Schema itself. Rejected: `x-telo-cel-type`, which names one reader of the annotation and would be a lie at the AJV, literal-authorability and polyglot boundaries (`kernel/rust` resolves `!include-bytes` with no CEL at all); `x-telo-runtime-type`, which excludes the brands, whose whole point is having no runtime existence; `x-telo-value-type`, accurate but signalling value-versus-reference semantics to a systems reader, exactly backwards for `Stream` and `Bytes`. The accepted cost is sharing the word with `inputType` / `outputType` / `Telo.Type`, which name shapes — complementary halves of one vocabulary, never at the same nesting level.
- **The keyword is short; the concept noun and API stay qualified.** `x-telo-type` in manifests, "value type" in docs, `value-type.ts` for the registry — a schema node gives the keyword its disambiguating context and prose has none. The same split `ref-slot.ts` already has against `x-telo-ref`.
- **The vocabulary is embedded data; the binding to a runtime is a per-language table.** Two kernels need the same entries — the Rust include arm types a slot from this registry with no CEL anywhere near it — so a registry written as Node code would be hand-copied and would drift silently, the divergence `analyzer/migrations/*.json` already exists to prevent. What is genuinely language-bound is small and separable: an `instance` entry names a symbolic `binding`, and each runtime maps that key to its own identity. Rejected: a single Node module as the whole extension point, which is only "the single place a type is defined" for one of the runtimes that must read it; and putting the constructor name in the entry, which is a fact about one language wearing the shape of data.
- **A missing binding is a hard startup error.** A type whose assertion cannot be produced would exempt every slot declaring it, silently converting a contract into a hole — the same class of failure as an unrecognized `use` token degrading to the legacy reading.
- **Registry data in the SDK, AJV codegen in the analyzer.** The SDK cannot depend on ajv; declaring a *representation* rather than a code fragment keeps the split clean. The SDK is where the data and the Node binding table live because it is dependency-free and Node-built-in-free (so the analyzer stays browser-safe), and because it is the only placement a module controller can reach. Rejected: an analyzer-side assertion map keyed by name, which would reintroduce a second place to edit.
- **Rewrite at load, not at schema-compile time, and as a migration entry rather than a bespoke pass.** `normalizeRefSlots` normalizes legacy ref slots at every compile site instead, which means every reader must keep the legacy knowledge. Rewriting once at load is what lets the old vocabulary be deleted in one place; expressing it as an entry is what gives the author `telo migrate` instead of prose, and what makes the same rewrite happen on both kernels. See `plans/manifest-migrations.md`.
- **The selector gains a schema region, not a kind list.** These annotations occur in author-written schemas inside ordinary resource documents, so an entry that enumerated the kinds carrying them would be both incomplete — the set is open, since any kind may declare a schema-valued field — and a violation of the topology-driven constraint. `inSchema` is stated in the **kernel's own** schema-valued key names, which no kind owns. Rejected: enumerating stdlib kinds in `inKind`, which teaches the analyzer about `Http.Api`; and leaving the resource-document occurrences unmigrated, which would mean every reader keeps dual knowledge forever and the deletion story is false.
- **The wildcard forms are gated on a reserved key.** `inKind: ["*"]` / `under: ["*"]` are legal only with `inSchema` and only for a rule keyed on an `x-telo-*` annotation, refused at entry-read time. Containment is then two independent bounds — where the walk may reach and what it may touch — rather than one weakened one, which is what keeps the module surface's promise (*a dependency renames its own field and provably nothing else*) intact: a module entry can no more spell `"*"` than it can name another module's kind.
- **The wildcard's cost is a wrong-rewrite residue, and the walk is not priced.** Dropping the bounded walk is a real change to the framework's shape but not a real cost at Telo's scale — a few manifests of a few thousand nodes — so this plan does not carry a performance argument it cannot defend. The residue it does carry is a schema literal inside an assertion's expected value, rewritten into its own synonym; it cannot be closed in a data-only matcher without naming kinds. Accepted, because the sites the wildcards reach are exactly the ones no enumeration covers, and the alternative leaves an author reading a deprecation `telo migrate` refuses to act on.
- **Rewriting needs containment; reporting does not.** The rewrite is bounded as above, while `validate-value-type-slots.ts` may report a legacy spelling anywhere it walks, since it never edits. Rejected: normalizing legacy spellings in the single accessor instead of migrating them — it is cheap and correct, and it is what would be right if the plan's premise were only a read path, but it leaves the author's file on the old spelling forever with no repair, which is the outcome `telo migrate` exists to prevent.
- **A type name is a closed built-in; a shape is named with `!ref`.** One grammar for each of the two things, and both are grammars Telo already has. Rejected: an alias-qualified dotted name resolving over named shapes, which is the reference grammar in string form — the spelling `INVALID_REFERENCE_FORM` exists to reject — and which would put a kind namespace (`x-telo-ref: Sql.Connection`) and an instance namespace (`Self.File`) in the same syntax in adjacent keys of one schema node, resolvable only by knowing which key you are looking at. Also rejected: keeping the bare-brand form, which cannot be told from a shape name at all.
- **`telo://<Alias>/<Type>` stops being an authoring surface, and is NOT retained beside `!ref`.** It resolves aliases in the declaring module's scope and is validated and canonicalized today, so keeping it would cost nothing to build — and that is not the question. It is a third naming grammar (URI authority as alias) against the `Alias.Name` form every other cross-boundary name uses, it duplicates alias resolution the reference system already performs, and it is the one reference spelling the editor's picker and go-to-definition cannot see. Rejected on those grounds alone, before effort enters. Its claimed portability does not survive either: `telo://` resolves to nothing outside Telo, so an unaware JSON Schema reader gets a broken reference rather than a usable one, and `analyzer/rust` already resolves `!ref` while having no `telo://` resolver — the tag is the cheaper polyglot path, not the dearer one.
- **The authoring form is a tag; the internal form is a `$ref`.** The loader normalizes `!ref` to the canonical `{$ref: "telo://<module>/<Type>"}` — the same authoring-sugar-to-canonical-form shape `resolveRefSentinels` and `resolveSchemaRefKinds` already have. Rejected: inlining the referenced shape, which is what "resolve it before compiling" would mean. The runtime preserves the reference form on purpose (`withStreamPropertiesSkipped` follows a `$ref` rather than substituting it) because inlining changes schema identity, and the compiled-validator cache is keyed on it; preserving it is also what leaves a recursive shape expressible. That is a property of validators generally, not of AJV — a Rust validator wants a registered `$id` just as much. Keeping the split is what lets the annotation be *validating* at no cost: the name half is canonical by construction, the shape half is a stable URI, and neither is an alias string.
- **The alias-aware resolver and the cross-boundary gate are work, not inheritance.** `resolveTypeFieldToSchema` ignores a resolved ref's `alias` and matches by bare name over the flattened list, so same-named shapes in two libraries collide; and a `Telo.Type` is `capability: Telo.Type` — no runtime instance — so `exports.resources` does not gate it and nothing else does either, under the old spelling or the new one. Both are stated as owned by this plan because an unstated inheritance is how a design ships a guarantee it does not have.
- **Shapes are open; representations are closed.** A module can name its own shape — as a `Telo.JsonSchema` resource, which is what YAML can express, reached by `!ref`. It cannot define a representation, which needs a constructor and an assertion in every runtime that hosts it, i.e. code plus a binding row. That is the joint the vocabulary is cut at, and it is a better line than deferring openness: the case authors actually need is available immediately, and the case that needs a delivery story stays kernel-owned until one exists.
- **A type argument is a schema node, not a new grammar.** An argument may be a JSON Schema, a built-in name, a `!ref`, or a parameterized type, and it nests to any depth because the recursion is JSON Schema's own. Rejected: an angle-bracket string syntax, which reads well for a named element and falls over the moment the element is an inline shape — the common case for record streams.
- **Named type parameters, not positional arguments.** `of` names itself in a diagnostic and lets a future two-parameter type add a second name without a migration; a positional list would report "argument 0" and fix arity into the syntax.
- **The argument lives inside the annotation, not in a native `items` beside it.** The symmetry is tempting — `type: array` pairs with `items`, so `x-telo-type: Stream` might too — but `analyzer/nodejs/src/schema-compat.ts`'s `navigateSchemaToExprPath` resolves `[N]` access by stepping through `items`, so an element schema there makes a stream slot indexable and hands out an element type at exactly the access the opacity rule forbids: two rules, one question, different answers. It also degrades the wrong way. `x-telo-binary`'s graceful degradation is safe because an unaware reader sees *unconstrained* — weaker than the truth; `items` on a stream reads as "every element is a string, and checkable", stronger than anything the runtime can enforce, since iterating a stream to validate it is precisely what the exemption forbids. Keeping them separate also leaves `items` free to mean what it always meant on a value type whose base really is an array.
- **The argument comparator is new code in a dead function's body, and the plan says so.** `checkSchemaCompatibility` has no callers, is not exported from the analyzer's index, compares only `type` for the names in `target.required`, and never looks at `items`, `$ref`, `anyOf` or `oneOf` — so "extended, not replaced" would have been a claim of reuse where only the posture is reused. Written there rather than beside it because a second comparator would have to agree with the first forever; carrying no regression risk because nothing exercises the first.
- **The check has one site, and it is named.** The producer's `outputType` navigated to the expression's tail, against the slot's declared argument, on the CEL wiring path. A registry annotation is read by several surfaces that do not compare anything, so leaving the site unstated is what would make `CEL_TYPE_ARGUMENT_MISMATCH` ambiguous about where it can fire — and a declared-but-unchecked `of` is a feature with no call site.
- **Exemption is from validation, never from typing.** A `live` type's value is never traversed; its declared argument still travels through every schema-typing walk, because that is where the comparison reads it. Generalizing the exemption to "wherever a schema is compiled" without this line would delete the check's own input at the moment it is introduced.
- **Arguments are covariant and gradual.** A stream is consumed by reading, so a narrower element satisfies a wider slot; an omitted argument is *any* in both directions, which is what keeps every unmigrated producer and consumer checking exactly as it does today.
- **Type arguments live in the schema layer and are erased at the CEL boundary.** cel-js types values by constructor identity, so a byte stream and a string stream are one CEL type and always will be. The argument check is a parallel structural pass over schemas the analyzer already walks. Rejected: registering a CEL type per instantiation, which the engine cannot express.
- **An unknown name is a hard error.** `X_TELO_TYPE_UNKNOWN` when a name is not a built-in, Levenshtein-suggested and scoped to the entry's own modules — a published dependency is not the consumer's to fix. This tightens `x-telo-type` itself, which today ignores an unrecognized brand silently. An argument naming a parameter the type does not declare is `X_TELO_TYPE_ARGUMENT_UNKNOWN` on the same terms; an unresolvable `!ref` argument is the existing reference diagnostic, unchanged, because it is an ordinary reference.
- **The deprecation is a warning, scoped to the entry's own modules**, so an app importing an unmigrated standard-library module sees no noise. The `X_TELO_REF_LEGACY_IDENTITY` precedent.
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

# a live handle, parameterized by a built-in value type — what every codec
# encoder produces, and today only prose in its `description`
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

A composite like a file is a **shape**, not a value type — only its bytes leaf is one — so it is declared the way any shape is, and reused the way any named resource is:

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

A multipart upload is then a stream of them, and an imported library's shape is reached exactly the same way — one spelling, the alias resolved in the declaring module's scope (which is the resolver change this plan owns). Whether the target must also be *listed* by the library is the gating question above, open and answered here rather than assumed:

```yaml
kind: Telo.Library
metadata: { name: Uploads }
imports:
  Ai: oci://ghcr.io/telorun/ai@0.4.0
---
kind: Telo.Definition
metadata: { name: ReceiveUpload }
capability: Telo.Invocable
inputType:
  type: object
  properties:
    # a shape declared in this same library
    files:
      x-telo-type: { name: Telo.Stream, of: !ref File }
    # a shape an imported library exports — the ordinary cross-module reference
    images:
      x-telo-type: { name: Telo.Stream, of: !ref Ai.ImageResult }
    # `of:` is a schema node, so a reference nests wherever one does
    batches:
      x-telo-type:
        name: Telo.Stream
        of:
          type: array
          items: !ref File
    # rejected — a reference has one spelling, and a dotted string here would be
    # the kind namespace's syntax over the instance namespace:
    #   thumbnails: { x-telo-type: { name: Telo.Stream, of: Self.File } }
  required: [files]
```

`modules/ai`'s `ImageResult` is already this shape, written today as `$ref: "telo://Self/ImageResult"` — which stays, as the form the loader normalizes these to internally, and stops being something an author writes.

Note where the tag may appear: `!ref` is accepted anywhere inside a **type argument**, at any depth, because that whole subtree is schema; it is never accepted in the **name** slot — `x-telo-type: !ref Something` is meaningless, since a name there is a built-in representation and a `Telo.JsonSchema` resource is not one.

Filling that byte slot, in a manifest — the embed is the only way in, since no YAML literal is ever bytes:

```yaml
- kind: Fs.Write
  metadata: { name: seedIcon }
  path: ./out/icon.png
  content: !include-bytes ./assets/icon.png
```

Writing `!include-text` there instead fails `telo check`, because the tag produces a string and the slot's declared type is `Telo.Bytes` — the same rule, read from the same entries, that rejects a plain YAML string at the slot, on either kernel.

Wiring that `output` into a consumer declaring `of: { type: string }` is `CEL_TYPE_ARGUMENT_MISMATCH`; wiring it into one declaring a bare `Telo.Stream` passes, because an omitted argument is *any*. Adding a fourth value type — parameterized or not — is one file in `sdk/value-types/` plus one binding row per runtime that can represent it.
