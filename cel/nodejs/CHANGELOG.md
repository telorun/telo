# @telorun/cel

## 0.112.0

## 0.111.0

### Minor Changes

- 587220a: `@telorun/cel`, `@telorun/sdk` and `@telorun/templating` are released under the MIT License from this version, and a published module carries its own license text.

  The three packages declare `"license": "MIT"` and ship the MIT text; their Rust twins (`telorun-sdk`, `telorun-sdk-core`, `telorun-sdk-macros`, `telorun-abi`, `telo-templating`) declare `license = "MIT"`. The analyzer, kernel, CLI and editor packages stay under the Sustainable Use License, and versions already published keep the license they shipped with.

  `telo publish` and `telo package` now carry a `LICENSE` file at a module's root with no `files:` entry: it ships in the artifact's `common` layer, beside the notices a `sources:` entry names. A module that keeps a `LICENSE` beside its `telo.yaml` therefore publishes one more file than before, which moves the pin of its published `telo.yaml` — republishing such a module at a version that is already published is refused, and needs a new `metadata.version`.

## 0.110.0

## 0.109.0

### Minor Changes

- 3fe9d3d: CEL evaluation is faster than the engine it replaces on every expression shape measured, and two public surfaces of `@telorun/cel` change to get there.

  **An implementation takes its call context first and its arguments positionally**, up to `CALL_SITE_DIRECT_ARITY` (4, the widest arity any registration declares), where it previously took an array of values and then the context. That is the contract a host's `registerFunction` implementation and a `CelCatalogHandlers` entry are written against. Both backends now pick a call-site entry point (`call0` … `call4`) from the arity they have, so a call allocates nothing and its monomorphic guard is a field compare per argument rather than a loop over an array; the array form remains for a call written wider than any signature may be. A signature past the bound is refused where it is registered, with the new `CelEngineError` code `signature_too_wide` — an implementation could otherwise only be called with its tail dropped. The arity of a _call_ is still the source's: `'42'.replace('2', '1', 1, false)` is five values and answers `no_matching_overload` naming the types it was handed.

  **A map's entries are keyed by each key's own typed value** rather than by a `s`/`n`/`b`-prefixed canonical text: a string or a bool is itself, and an int, a uint and a whole double are all the `bigint` CEL equality makes them. Every guarantee the prefix carried is unchanged — one container holds CEL's four key types, `1` and `1u` are one key while `"1"` is another, `__proto__` round-trips as data, a double that is not whole is no key — because a `Map` compares a key by type as well as by value. `CelMap.entries` is therefore keyed by the new `CelMapKey` (`string | bigint | boolean`), `celMapFromEntries` takes its entries flat (key, value, key, value) instead of as pairs, and **`mapKeyIdentity` is no longer exported**: what identifies an entry is the entries map's own business, and a host reads a map through the member-read seam and walks `entries` for the pairs.

  Beside those, a member read of a record's own string-keyed entry asks what the container is once instead of three times, and a comprehension no longer copies the list it ranges over.

  Measured against `@marcbachmann/cel-js` (medians of 25 alternating rounds, 10k evaluations each, one process): a string comparison 1.13× faster emitted and 1.08× closure; a three-term guard building a URL 1.30× and 1.26×; a filter with a nested `exists` building a five-key map literal per element 1.20× and 1.07×. The emitted backend had been 1.32×–1.47× _slower_ than cel-js on those same expressions, which is the defect this closes — transpilation that cost more than interpreting.

  `EMITTER_FORMAT_GENERATION` is 2: the emitted text changes for every call in every tree and for every map literal, so a module cached under generation 1 is recompiled rather than run.

  A faster alternative was measured and refused: a `typeof`-keyed table of operator implementations beside the runtime library reaches 1.68× on the guard expression, and is global, outside the environment digest, and consults no registry on a hit — so a host that registers its own `==` over two strings gets the standard library's answer back on every call. A replaceable standard library is what the package exists for. The new `tests/call-site-identity.test.ts` holds every call the registry lists to answering the same cold as warm, and a site driven through several argument types to answering as a site that never ran, so a re-introduced table fails on its first run.

  ***

  **`@telorun/sdk`'s value domain is `@telorun/cel`.** `Duration` and `UnsignedInt` — the two classes every Telo package and controller obtained from the SDK — are **gone**, and with them the realm probe that asserted the engine's copy of them was the SDK's. A CEL value says what it is under `Symbol.for("telo.cel.value")`, which is the same symbol in every copy, so two independently loaded engines agree about a duration or a uint with nothing deduplicated and nothing to assert. In their place the SDK re-exports the engine's own vocabulary: `celUint` / `isCelUint`, `celDurationFromNanos` / `isCelDuration` / `durationNanos` / `formatDuration` / `parseDuration`, `celTimestamp` / `isCelTimestamp`, and `isCelRecord`. The fields are the ones they were (`.value`, `.seconds`, `.nanos`); `new` and `instanceof` are not. There is one duration constructor and it takes total nanoseconds, so a duration outside CEL's range cannot be built — it answers the range error instead. A CEL duration no longer renders itself: `String(duration)` was `"5400s"` and is now `[object Object]`, so `formatDuration` is what writes one.

  **`ValueTypeBinding.constructor` is now `holds`**, a predicate. A brand has no constructor to test, and a predicate covers both kinds of identity — a host class answers with `instanceof`, a branded value by its type key. A `live` binding now declares a `placeholder` too, because building a stand-in belongs to the binding, which is the only thing that knows what the value is.

  **`isCelRecord` is the companion every structural walk needs.** A branded value is a _plain_ object, so a walk that decided "is this a container to descend into?" by testing the prototype now descends into a duration and rebuilds it without its brand — where a class instance was returned untouched. The kernel's BigInt schema view was the first such walk and now asks the value domain instead; the rest of the walks are a sweep this change does not finish.

  **`durationNanosFromText` is new on `@telorun/cel`**: CEL's duration grammar with no range applied. The grammar and the range are separate questions and a reader outside CEL has the same grammar with a different range — protobuf's `google.protobuf.Duration` reaches ±10,000 years, which **cannot be held in an int64 of nanoseconds at all**, so the typed frame and the `cel-duration` plain encoding cannot go through `parseDuration` and would otherwise restate the grammar. `parseDuration` is now that function plus CEL's range check.

  **`@telorun/cel` joins `REALM_COLLAPSE_NAMES`**, and the bundle builder's refusal of a controller that inlined the CEL engine is **deleted**. That guard existed because values were typed by constructor, so an inlined copy's `Duration` was foreign to the kernel's; it is not any more. What a second copy still duplicates is everything the engine _holds_ — its registry, its environments and their caches, the emitted-module store's keys — which is why it is collapsed rather than left alone.

  ***

  **`@marcbachmann/cel-js` is gone from the repository, and `@telorun/cel` is what every package runs on.** The engine was built alongside it and consumed by nothing; this is the cutover.

  **`@telorun/templating` no longer declares a CEL function or classifies a CEL verdict.** Telo's 67 functions and their 86 signatures ship inside the engine as data plus implementations, so `cel/catalog.ts` — 1,455 lines of table — and `cel/json-prefix-scan.ts` are deleted, and `registerFunctionCatalog` is what the dialect is. Removed from the package's surface: `CEL_FUNCTIONS`, `CelFunctionInfo`, `CelFunctionDoc`, `CelFunctionCategory`, `deriveSignatures`, `functionIndex`, `resolveModuleCalls`. `celFunctionCatalog()` now re-exports the engine's one listing surface (its entries carry `signatures`, `category`, `summary`, `deterministic`, `hostBacked`, `checksLiteralArguments`), `moduleCallNames(root)` is new, and `auditCalls` gained a trailing `checked?` parameter while its `diagnostics`, `unresolved` and `argumentIssues` are now always empty — the engine decides every call verdict itself.

  Two mechanisms disappear with their causes rather than being ported:

  - **The call classifier.** It existed because the replaced engine reported one sentence for three unrelated mistakes (`found no matching overload for 'f(...)'`), two of whose readings actively misled — the message named argument types, so the repair for `startsWith(key, 'x')` looked like a cast when the fix was `key.startsWith('x')`. The engine decides an unknown name, a name called in the other form, an unknown field, a type no overload takes and a refusal over a literal argument each where its cause is known, with a range and a whole-source fix. So a diagnostic is the engine's, coded, and nothing reads a message. The verdict vocabulary gains `CEL_TYPE_ARGUMENT_MISMATCH`, `FUNCTION_UNRESOLVED`, `FUNCTION_ARITY_MISMATCH` and `FUNCTION_ARGUMENT_MISMATCH`.
  - **The module-call tree rewrite.** `Alias.fn(x)` and `obj.method(x)` are the same syntax, so templating used to rewrite the parsed tree through internals the replaced engine did not expose: a `setMeta('macro', …)` redirect, a comprehension macro's `alternate` winning over `macro` unless cleared, an rcall's asyncness read off checker state. Three facts about a dependency's internals, each pinned by a test, and the reason it was pinned to an exact version. `qcall` is now a node of its own, produced by a total pass over the name set, and a parsed expression records the set it was resolved under — so an environment refuses a tree resolved for another site instead of answering a different question about it.

  **`registerValueBrands` declares rather than implements.** A nominal type's conversions and members are signatures over `Self`; the replaced engine required a function body per registration, so three stubs existed that a brand's values never reached.

  **`re2js` and `uuid` moved to the engine** at the same exact pins the vectors ran against.

  Also new on `@telorun/cel`: `durationNanosFromText` (the duration grammar with no range applied — see above), and `BINDING_FORMS` / `receiverMacroBinding` / `namespaceMacroBinding`, so a host walking a tree asks the engine which forms bind a name instead of keeping a list of comprehension method names in step with it.

  **The gate for this cutover is a diagnostic census, not "no manifest was edited."** `scripts/cel-cutover-census.mjs` records every diagnostic `telo check` reports over every manifest in the repository as `(file, line, column, code)` — 1,194 manifests, 661 diagnostics, 10 distinct CEL codes — taken before the swap and again after, and diffed. "No manifest was edited" is a proxy that is blind to a verdict that DISAPPEARS: a manifest that reported a warning before and reports nothing after is edited by nobody and is exactly the regression an engine swap causes. A first pass over the 569 real manifests found three CEL diagnostics in all; the 382 negative fixtures under `tests/__fixtures__` are where the verdicts live, and without them the census pins the clean half of the corpus and calls it the corpus.

  ***

  **`FUNCTION_NAME_RESERVED` is removed, cause and all.** A `Telo.Function` could not be named `map`, `filter`, `all`, `exists`, `exists_one` or `bind`, because the engine this replaced expanded `<Module>.map(…)` as its own macro before a module call could resolve, so most calls to such a function did not parse. **Namespace resolution now outranks macro expansion**: a call whose receiver is one of the declaring module's names is a qualified call whatever the function is called, and a call on a VALUE is still the macro. Verified by execution over every macro name — each parses as a qualified call with no diagnostic — and `Alias.filter(21)` is judged like any other module call. The diagnostic, its runtime twin in `tests/check-run-agreement.yaml`, and its row in `docs/reference/diagnostics.md` are gone; the fixture's function named `filter` stays, as evidence that the name is ordinary.

  **The cutover's gate, and what it found.** `scripts/cel-cutover-census.mjs` records every diagnostic `telo check` reports over every manifest in the repository as `(file, line, column, code)` — 1,194 manifests — taken before the swap and again after, and diffed. It exists because "no manifest was edited" is a proxy that cannot see a verdict that DISAPPEARS, which is the regression an engine swap causes. Result: **661 → 775 diagnostics, no code disappeared**, and 33 positions lost every diagnostic they had. Each of those was chased rather than accepted:

  - **36 `CONTRACT_INPUTS_MISMATCH` and 17 `SCHEMA_VIOLATION` were false positives.** The clearest case is `modules/openai/tests/tool-choice-request.yaml`, where `inputs: !cel "steps.request.result"` was reported as not satisfying the target's `inputType` at three steps — and the manifest runs green. A static mismatch against a manifest that executes correctly is a verdict that should not have been there; the engine types the expression honestly and the report is gone. The stand-in cases are the same shape, and one fixture's own comment already said the stand-in should be excused.
  - **`REFERRER_RULE_INVALID` 0 → 99 and `RESOURCE_RULE_INVALID` 1 → 8** all trace to one published rule and one semantic question — whether an optional member read (`a.?b`) on a value that holds no members answers absent or an error. That is being decided on its own terms, not patched.

- 3fe9d3d: **A presence-shaped read over a value that holds no members answers "absent", not an error.** `a.?b` and `a[?k]` answer `optional.none()` and `has(a.b)` answers `false` wherever `a` turns out to be a string, a number, a bool, bytes, an instant, a span, `null` or a value of a host's own named type — where each of the three used to fail the whole evaluation with `unsupported_container`. That is how a field holding two shapes is discriminated without a type test, which is what the SQL schema module's `SQL_ENUM_NOT_DECLARED` rule does: it was reporting `REFERRER_RULE_INVALID` on 99 manifests instead of evaluating, and now evaluates.

  The authority is the optional library's own. It enters this engine from cel-go whole, and cel-go's attribute qualification answers "not found" for a receiver that is neither a mapper, a lister nor an indexer **whenever the read is a presence test**; erroring instead is an explicitly named opt-in (`EnableErrorOnBadPresenceTest`) which Telo deliberately does not carry — a per-environment switch over what an expression MEANS would let the analyzer and a kernel disagree about one manifest.

  **Three readings are unchanged, and they are what keeps the loosening from hiding a mistake.** An _ordinary_ read of such a member (`a.b`, `a['b']`, `a[k]`) is still `unsupported_container`; so is the ordinary step of a chain that has already entered optional land (`a.?b.c` where `b` holds no members), which is cel-spec's own answer for `{true: dyn(0)}[?true].absent`; and an unusable **key** — `[?3.1]`, or a name indexing a list — is still `unsupported_key_type` in every form, optional included, because it names an entry no container of that shape could hold.

  **Statically the strictness moves rather than relaxes.** An operand whose type is _known_ to hold no members is refused with `CEL_TYPE_ERROR` ("… holds no members") in the presence forms exactly as in the plain one — `.?` over a declared string is a mistake the check still states — so the runtime's absence answer is reached only through a `dyn` the check could not judge. The one thing that becomes legal is a **union with at least one member-holding branch**: `has(x.name)` and `x.?name` over a field declared as a string _or_ an object with `name` now check clean and type as `optional<string>`, the member-less branches being the absence case, while the ordinary `x.name` stays refused. There is no new diagnostic code and no new environment option.

  What now silently succeeds and used to be reported: a mistake in the _operand_ chain over a `dyn` value that turns out to be a scalar — writing `x.type.?name` where `x.?type` was meant — is an absent optional instead of an evaluation error. A field typo was already absence, so that is exactly the newly hidden class; the static half above, over any field whose shape a schema declares, is its compensating coverage.

- 3fe9d3d: Two of `@telorun/cel`'s diagnostics give a reader back what the engine it replaces told them.

  **A call on a name nothing registers names the names that would have worked.** `no(1)` was `no function named "no" is registered` and is now `no function named "no" is registered — the closest taking 1 argument: int, abs, avg, bool, dyn` in an environment carrying the function catalog: the candidates are the registered names that accept the call's form and arity, at most `UNKNOWN_FUNCTION_CANDIDATES` (5) of them, ordered by edit distance over the name as written and then by name — a declared bound and a declared order, because the conformance vectors pin the message byte for byte and a selection a second engine cannot reproduce would be a row no port can pass. A name that cannot be written as a call is filtered out, so the operators (`!`, `-`, `+`) are never offered. The message names no command to run: which listing a host offers is the host's, and an engine embedded in a host with no command line would be pointing at nothing. The single rename fix is unchanged and still singular — `'a'.startswith('b')` still offers its one rename — because a list of five repairs is not a repair.

  **A namespace declaration whose type nothing is registered under is a ranged verdict instead of a throw.** `registerNamespace` accepted `{ name: 'untyped', returns: 'NoSuchType' }` by throwing `CelTypeExpressionError` out of registration, which left a host no path at all: a module function's declared result is data out of someone's manifest, so one author's typo became a crash with no line. Now the declaration is accepted, reads `dyn` where that type stood, and every call to it carries a ranged `CEL_TYPE_ERROR` naming it — the same rule an unjudged schema node already follows, reported beside the structural reading by the consumer that knows where the declaration was written. It holds for a withheld-parameter declaration's `returns` and for a full signature's parameters alike. `CelTypeExpressionError` keeps what it is actually about — text this grammar cannot read — and the new `CelUnknownTypeNameError` is what a well-formed expression naming an unregistered type throws for every other caller.

- 3fe9d3d: **The branded CEL timestamp is Telo's one timestamp value, and a `Date` is never a Telo value.** An instant is `{ seconds, nanos }` in `0001-01-01T00:00:00Z … 9999-12-31T23:59:59.999999999Z`, asked with `isCelTimestamp` and built with `celTimestamp(seconds, nanos)` or the new `celTimestampFromMillis(ms)` — the mirror of `celDurationFromNanos` for a host clock reading. A `Date` is a foreign host object: it is refused at a `Telo.Timestamp` slot, at `telo check` and at creation alike (the stand-in the analyzer substitutes is built from the same binding the kernel asserts with), and a typed frame refuses one at its path, naming the factory to use. A writer producing text for a reader outside the value domain — a log line, a chart label — may still hold one.

  **One timestamp text, everywhere: RFC 3339 in UTC with a `Z` and a trimmed fraction.** Absent when the instant is whole, otherwise one to nine digits with no trailing zero — CEL's own `string(timestamp)`, which is now the authority for the `rfc3339` plain encoding, the `google.protobuf.Timestamp` frame payload, the plain JSON writer, a log record, an `!interpolate` hole and a manifest literal. So `2026-01-15T07:30:00Z` rather than `…00.000Z`, and `…00.000000001Z` is representable where the millisecond floor made it unwritable. A tenth fractional digit is refused rather than rounded, in both directions.

  **The millisecond floor is gone from the spec, not just from the code.** `kernel/specs/durable-execution.md` §6.3 stated it and gave Node's host `Date` as its reason in the same breath; the timestamp payload is now the duration's rule, and §6.6's vectors carry a nanosecond instant as a value.

  Two pins that name the frame's payload grammar move with it: the recorded-value codec version is `2`, and version `1` is still READ under its own grammar (exactly three fractional digits) so a run parked before this change resumes rather than being stranded; the controller-protocol generation is `telo-5` (`4` is withdrawn, having named the millisecond payload and never been spoken by any carrier). The emitter's format generation is untouched — no emitted text changes.

  The Rust half lands with it: `kernel/rust` / `sdk/rust` carry the nanosecond `Timestamp` and the same canonical text, over the one shared vector file both halves read.

## 0.108.0

### Minor Changes

- 8c94cc0: CEL evaluation is faster than the engine it replaces on every expression shape measured, and two public surfaces of `@telorun/cel` change to get there.

  **An implementation takes its call context first and its arguments positionally**, up to `CALL_SITE_DIRECT_ARITY` (4, the widest arity any registration declares), where it previously took an array of values and then the context. That is the contract a host's `registerFunction` implementation and a `CelCatalogHandlers` entry are written against. Both backends now pick a call-site entry point (`call0` … `call4`) from the arity they have, so a call allocates nothing and its monomorphic guard is a field compare per argument rather than a loop over an array; the array form remains for a call written wider than any signature may be. A signature past the bound is refused where it is registered, with the new `CelEngineError` code `signature_too_wide` — an implementation could otherwise only be called with its tail dropped. The arity of a _call_ is still the source's: `'42'.replace('2', '1', 1, false)` is five values and answers `no_matching_overload` naming the types it was handed.

  **A map's entries are keyed by each key's own typed value** rather than by a `s`/`n`/`b`-prefixed canonical text: a string or a bool is itself, and an int, a uint and a whole double are all the `bigint` CEL equality makes them. Every guarantee the prefix carried is unchanged — one container holds CEL's four key types, `1` and `1u` are one key while `"1"` is another, `__proto__` round-trips as data, a double that is not whole is no key — because a `Map` compares a key by type as well as by value. `CelMap.entries` is therefore keyed by the new `CelMapKey` (`string | bigint | boolean`), `celMapFromEntries` takes its entries flat (key, value, key, value) instead of as pairs, and **`mapKeyIdentity` is no longer exported**: what identifies an entry is the entries map's own business, and a host reads a map through the member-read seam and walks `entries` for the pairs.

  Beside those, a member read of a record's own string-keyed entry asks what the container is once instead of three times, and a comprehension no longer copies the list it ranges over.

  Measured against `@marcbachmann/cel-js` (medians of 25 alternating rounds, 10k evaluations each, one process): a string comparison 1.13× faster emitted and 1.08× closure; a three-term guard building a URL 1.30× and 1.26×; a filter with a nested `exists` building a five-key map literal per element 1.20× and 1.07×. The emitted backend had been 1.32×–1.47× _slower_ than cel-js on those same expressions, which is the defect this closes — transpilation that cost more than interpreting.

  `EMITTER_FORMAT_GENERATION` is 2: the emitted text changes for every call in every tree and for every map literal, so a module cached under generation 1 is recompiled rather than run.

  A faster alternative was measured and refused: a `typeof`-keyed table of operator implementations beside the runtime library reaches 1.68× on the guard expression, and is global, outside the environment digest, and consults no registry on a hit — so a host that registers its own `==` over two strings gets the standard library's answer back on every call. A replaceable standard library is what the package exists for. The new `tests/call-site-identity.test.ts` holds every call the registry lists to answering the same cold as warm, and a site driven through several argument types to answering as a site that never ran, so a re-introduced table fails on its first run.

  ***

  **`@telorun/sdk`'s value domain is `@telorun/cel`.** `Duration` and `UnsignedInt` — the two classes every Telo package and controller obtained from the SDK — are **gone**, and with them the realm probe that asserted the engine's copy of them was the SDK's. A CEL value says what it is under `Symbol.for("telo.cel.value")`, which is the same symbol in every copy, so two independently loaded engines agree about a duration or a uint with nothing deduplicated and nothing to assert. In their place the SDK re-exports the engine's own vocabulary: `celUint` / `isCelUint`, `celDurationFromNanos` / `isCelDuration` / `durationNanos` / `formatDuration` / `parseDuration`, `celTimestamp` / `isCelTimestamp`, and `isCelRecord`. The fields are the ones they were (`.value`, `.seconds`, `.nanos`); `new` and `instanceof` are not. There is one duration constructor and it takes total nanoseconds, so a duration outside CEL's range cannot be built — it answers the range error instead. A CEL duration no longer renders itself: `String(duration)` was `"5400s"` and is now `[object Object]`, so `formatDuration` is what writes one.

  **`ValueTypeBinding.constructor` is now `holds`**, a predicate. A brand has no constructor to test, and a predicate covers both kinds of identity — a host class answers with `instanceof`, a branded value by its type key. A `live` binding now declares a `placeholder` too, because building a stand-in belongs to the binding, which is the only thing that knows what the value is.

  **`isCelRecord` is the companion every structural walk needs.** A branded value is a _plain_ object, so a walk that decided "is this a container to descend into?" by testing the prototype now descends into a duration and rebuilds it without its brand — where a class instance was returned untouched. The kernel's BigInt schema view was the first such walk and now asks the value domain instead; the rest of the walks are a sweep this change does not finish.

  **`durationNanosFromText` is new on `@telorun/cel`**: CEL's duration grammar with no range applied. The grammar and the range are separate questions and a reader outside CEL has the same grammar with a different range — protobuf's `google.protobuf.Duration` reaches ±10,000 years, which **cannot be held in an int64 of nanoseconds at all**, so the typed frame and the `cel-duration` plain encoding cannot go through `parseDuration` and would otherwise restate the grammar. `parseDuration` is now that function plus CEL's range check.

  **`@telorun/cel` joins `REALM_COLLAPSE_NAMES`**, and the bundle builder's refusal of a controller that inlined the CEL engine is **deleted**. That guard existed because values were typed by constructor, so an inlined copy's `Duration` was foreign to the kernel's; it is not any more. What a second copy still duplicates is everything the engine _holds_ — its registry, its environments and their caches, the emitted-module store's keys — which is why it is collapsed rather than left alone.

  ***

  **`@marcbachmann/cel-js` is gone from the repository, and `@telorun/cel` is what every package runs on.** The engine was built alongside it and consumed by nothing; this is the cutover.

  **`@telorun/templating` no longer declares a CEL function or classifies a CEL verdict.** Telo's 67 functions and their 86 signatures ship inside the engine as data plus implementations, so `cel/catalog.ts` — 1,455 lines of table — and `cel/json-prefix-scan.ts` are deleted, and `registerFunctionCatalog` is what the dialect is. Removed from the package's surface: `CEL_FUNCTIONS`, `CelFunctionInfo`, `CelFunctionDoc`, `CelFunctionCategory`, `deriveSignatures`, `functionIndex`, `resolveModuleCalls`. `celFunctionCatalog()` now re-exports the engine's one listing surface (its entries carry `signatures`, `category`, `summary`, `deterministic`, `hostBacked`, `checksLiteralArguments`), `moduleCallNames(root)` is new, and `auditCalls` gained a trailing `checked?` parameter while its `diagnostics`, `unresolved` and `argumentIssues` are now always empty — the engine decides every call verdict itself.

  Two mechanisms disappear with their causes rather than being ported:

  - **The call classifier.** It existed because the replaced engine reported one sentence for three unrelated mistakes (`found no matching overload for 'f(...)'`), two of whose readings actively misled — the message named argument types, so the repair for `startsWith(key, 'x')` looked like a cast when the fix was `key.startsWith('x')`. The engine decides an unknown name, a name called in the other form, an unknown field, a type no overload takes and a refusal over a literal argument each where its cause is known, with a range and a whole-source fix. So a diagnostic is the engine's, coded, and nothing reads a message. The verdict vocabulary gains `CEL_TYPE_ARGUMENT_MISMATCH`, `FUNCTION_UNRESOLVED`, `FUNCTION_ARITY_MISMATCH` and `FUNCTION_ARGUMENT_MISMATCH`.
  - **The module-call tree rewrite.** `Alias.fn(x)` and `obj.method(x)` are the same syntax, so templating used to rewrite the parsed tree through internals the replaced engine did not expose: a `setMeta('macro', …)` redirect, a comprehension macro's `alternate` winning over `macro` unless cleared, an rcall's asyncness read off checker state. Three facts about a dependency's internals, each pinned by a test, and the reason it was pinned to an exact version. `qcall` is now a node of its own, produced by a total pass over the name set, and a parsed expression records the set it was resolved under — so an environment refuses a tree resolved for another site instead of answering a different question about it.

  **`registerValueBrands` declares rather than implements.** A nominal type's conversions and members are signatures over `Self`; the replaced engine required a function body per registration, so three stubs existed that a brand's values never reached.

  **`re2js` and `uuid` moved to the engine** at the same exact pins the vectors ran against.

  Also new on `@telorun/cel`: `durationNanosFromText` (the duration grammar with no range applied — see above), and `BINDING_FORMS` / `receiverMacroBinding` / `namespaceMacroBinding`, so a host walking a tree asks the engine which forms bind a name instead of keeping a list of comprehension method names in step with it.

  **The gate for this cutover is a diagnostic census, not "no manifest was edited."** `scripts/cel-cutover-census.mjs` records every diagnostic `telo check` reports over every manifest in the repository as `(file, line, column, code)` — 1,194 manifests, 661 diagnostics, 10 distinct CEL codes — taken before the swap and again after, and diffed. "No manifest was edited" is a proxy that is blind to a verdict that DISAPPEARS: a manifest that reported a warning before and reports nothing after is edited by nobody and is exactly the regression an engine swap causes. A first pass over the 569 real manifests found three CEL diagnostics in all; the 382 negative fixtures under `tests/__fixtures__` are where the verdicts live, and without them the census pins the clean half of the corpus and calls it the corpus.

  ***

  **`FUNCTION_NAME_RESERVED` is removed, cause and all.** A `Telo.Function` could not be named `map`, `filter`, `all`, `exists`, `exists_one` or `bind`, because the engine this replaced expanded `<Module>.map(…)` as its own macro before a module call could resolve, so most calls to such a function did not parse. **Namespace resolution now outranks macro expansion**: a call whose receiver is one of the declaring module's names is a qualified call whatever the function is called, and a call on a VALUE is still the macro. Verified by execution over every macro name — each parses as a qualified call with no diagnostic — and `Alias.filter(21)` is judged like any other module call. The diagnostic, its runtime twin in `tests/check-run-agreement.yaml`, and its row in `docs/reference/diagnostics.md` are gone; the fixture's function named `filter` stays, as evidence that the name is ordinary.

  **The cutover's gate, and what it found.** `scripts/cel-cutover-census.mjs` records every diagnostic `telo check` reports over every manifest in the repository as `(file, line, column, code)` — 1,194 manifests — taken before the swap and again after, and diffed. It exists because "no manifest was edited" is a proxy that cannot see a verdict that DISAPPEARS, which is the regression an engine swap causes. Result: **661 → 775 diagnostics, no code disappeared**, and 33 positions lost every diagnostic they had. Each of those was chased rather than accepted:

  - **36 `CONTRACT_INPUTS_MISMATCH` and 17 `SCHEMA_VIOLATION` were false positives.** The clearest case is `modules/openai/tests/tool-choice-request.yaml`, where `inputs: !cel "steps.request.result"` was reported as not satisfying the target's `inputType` at three steps — and the manifest runs green. A static mismatch against a manifest that executes correctly is a verdict that should not have been there; the engine types the expression honestly and the report is gone. The stand-in cases are the same shape, and one fixture's own comment already said the stand-in should be excused.
  - **`REFERRER_RULE_INVALID` 0 → 99 and `RESOURCE_RULE_INVALID` 1 → 8** all trace to one published rule and one semantic question — whether an optional member read (`a.?b`) on a value that holds no members answers absent or an error. That is being decided on its own terms, not patched.

- 8c94cc0: **A presence-shaped read over a value that holds no members answers "absent", not an error.** `a.?b` and `a[?k]` answer `optional.none()` and `has(a.b)` answers `false` wherever `a` turns out to be a string, a number, a bool, bytes, an instant, a span, `null` or a value of a host's own named type — where each of the three used to fail the whole evaluation with `unsupported_container`. That is how a field holding two shapes is discriminated without a type test, which is what the SQL schema module's `SQL_ENUM_NOT_DECLARED` rule does: it was reporting `REFERRER_RULE_INVALID` on 99 manifests instead of evaluating, and now evaluates.

  The authority is the optional library's own. It enters this engine from cel-go whole, and cel-go's attribute qualification answers "not found" for a receiver that is neither a mapper, a lister nor an indexer **whenever the read is a presence test**; erroring instead is an explicitly named opt-in (`EnableErrorOnBadPresenceTest`) which Telo deliberately does not carry — a per-environment switch over what an expression MEANS would let the analyzer and a kernel disagree about one manifest.

  **Three readings are unchanged, and they are what keeps the loosening from hiding a mistake.** An _ordinary_ read of such a member (`a.b`, `a['b']`, `a[k]`) is still `unsupported_container`; so is the ordinary step of a chain that has already entered optional land (`a.?b.c` where `b` holds no members), which is cel-spec's own answer for `{true: dyn(0)}[?true].absent`; and an unusable **key** — `[?3.1]`, or a name indexing a list — is still `unsupported_key_type` in every form, optional included, because it names an entry no container of that shape could hold.

  **Statically the strictness moves rather than relaxes.** An operand whose type is _known_ to hold no members is refused with `CEL_TYPE_ERROR` ("… holds no members") in the presence forms exactly as in the plain one — `.?` over a declared string is a mistake the check still states — so the runtime's absence answer is reached only through a `dyn` the check could not judge. The one thing that becomes legal is a **union with at least one member-holding branch**: `has(x.name)` and `x.?name` over a field declared as a string _or_ an object with `name` now check clean and type as `optional<string>`, the member-less branches being the absence case, while the ordinary `x.name` stays refused. There is no new diagnostic code and no new environment option.

  What now silently succeeds and used to be reported: a mistake in the _operand_ chain over a `dyn` value that turns out to be a scalar — writing `x.type.?name` where `x.?type` was meant — is an absent optional instead of an evaluation error. A field typo was already absence, so that is exactly the newly hidden class; the static half above, over any field whose shape a schema declares, is its compensating coverage.

- 8c94cc0: Two of `@telorun/cel`'s diagnostics give a reader back what the engine it replaces told them.

  **A call on a name nothing registers names the names that would have worked.** `no(1)` was `no function named "no" is registered` and is now `no function named "no" is registered — the closest taking 1 argument: int, abs, avg, bool, dyn` in an environment carrying the function catalog: the candidates are the registered names that accept the call's form and arity, at most `UNKNOWN_FUNCTION_CANDIDATES` (5) of them, ordered by edit distance over the name as written and then by name — a declared bound and a declared order, because the conformance vectors pin the message byte for byte and a selection a second engine cannot reproduce would be a row no port can pass. A name that cannot be written as a call is filtered out, so the operators (`!`, `-`, `+`) are never offered. The message names no command to run: which listing a host offers is the host's, and an engine embedded in a host with no command line would be pointing at nothing. The single rename fix is unchanged and still singular — `'a'.startswith('b')` still offers its one rename — because a list of five repairs is not a repair.

  **A namespace declaration whose type nothing is registered under is a ranged verdict instead of a throw.** `registerNamespace` accepted `{ name: 'untyped', returns: 'NoSuchType' }` by throwing `CelTypeExpressionError` out of registration, which left a host no path at all: a module function's declared result is data out of someone's manifest, so one author's typo became a crash with no line. Now the declaration is accepted, reads `dyn` where that type stood, and every call to it carries a ranged `CEL_TYPE_ERROR` naming it — the same rule an unjudged schema node already follows, reported beside the structural reading by the consumer that knows where the declaration was written. It holds for a withheld-parameter declaration's `returns` and for a full signature's parameters alike. `CelTypeExpressionError` keeps what it is actually about — text this grammar cannot read — and the new `CelUnknownTypeNameError` is what a well-formed expression naming an unregistered type throws for every other caller.

- 8c94cc0: **The branded CEL timestamp is Telo's one timestamp value, and a `Date` is never a Telo value.** An instant is `{ seconds, nanos }` in `0001-01-01T00:00:00Z … 9999-12-31T23:59:59.999999999Z`, asked with `isCelTimestamp` and built with `celTimestamp(seconds, nanos)` or the new `celTimestampFromMillis(ms)` — the mirror of `celDurationFromNanos` for a host clock reading. A `Date` is a foreign host object: it is refused at a `Telo.Timestamp` slot, at `telo check` and at creation alike (the stand-in the analyzer substitutes is built from the same binding the kernel asserts with), and a typed frame refuses one at its path, naming the factory to use. A writer producing text for a reader outside the value domain — a log line, a chart label — may still hold one.

  **One timestamp text, everywhere: RFC 3339 in UTC with a `Z` and a trimmed fraction.** Absent when the instant is whole, otherwise one to nine digits with no trailing zero — CEL's own `string(timestamp)`, which is now the authority for the `rfc3339` plain encoding, the `google.protobuf.Timestamp` frame payload, the plain JSON writer, a log record, an `!interpolate` hole and a manifest literal. So `2026-01-15T07:30:00Z` rather than `…00.000Z`, and `…00.000000001Z` is representable where the millisecond floor made it unwritable. A tenth fractional digit is refused rather than rounded, in both directions.

  **The millisecond floor is gone from the spec, not just from the code.** `kernel/specs/durable-execution.md` §6.3 stated it and gave Node's host `Date` as its reason in the same breath; the timestamp payload is now the duration's rule, and §6.6's vectors carry a nanosecond instant as a value.

  Two pins that name the frame's payload grammar move with it: the recorded-value codec version is `2`, and version `1` is still READ under its own grammar (exactly three fractional digits) so a run parked before this change resumes rather than being stranded; the controller-protocol generation is `telo-5` (`4` is withdrawn, having named the millisecond payload and never been spoken by any carrier). The emitter's format generation is untouched — no emitted text changes.

  The Rust half lands with it: `kernel/rust` / `sdk/rust` carry the nanosecond `Timestamp` and the same canonical text, over the one shared vector file both halves read.

## 0.107.0

### Minor Changes

- 3dd7be0: Two defects in `@telorun/cel`'s evaluation, and the gates that could not see them.

  **A value that must be awaited is refused at every door it comes through, and the doors are now a named
  list.** A thenable was refused at an
  activation read, at a host implementation's result, at dispatch and at the program's exit — so `x.p`,
  `x.p + 1` and `[x.p][0]` were `async_value_unsupported`, while **`[x.p]` answered a list holding the
  promise** and `{'k': x.p}` a map holding it. The guard sat where the value was later used rather than
  where the read answers, which is one character short of the shape a manifest actually writes
  (`!cel "[resources.x.status.p]"`). The check now sits in the member read itself, covering `a.b`,
  `a['b']`, `.?` and `[?]`, and an absent-or-awaited optional is refused rather than wrapped as present.

  The same guard was missing at **every form that binds a value into a body**, and there it was worse than a
  leak: `xs.all(e, true)` over a host list holding a promise answered **`true`** — a wrong answer decided
  about a value nothing touched. The element is now refused where it enters a body, in the one place a
  comprehension's meaning lives, so both backends inherit it; and with it the value `cel.bind` binds, an
  optional's held value entering `optMap` / `optFlatMap`, and list membership, which reads every element
  without binding one. One refusal serves all of them (`asyncValueRefused`), so no door answers with a
  different code or wording, and the forms are **data** (`BINDING_FORMS`) held to a probe per form, each
  probed under a constant predicate and a reference comparison both — a tenth binding form cannot be added
  unguarded.

  **That refusal is terminal**, which is what makes it worth anything: carried as an ordinary CEL error it
  was discardable, so `[P, 2].all(e, false)` answered `false` and `[P, 2].exists(e, true)` answered `true`,
  each decided off the one element the engine could read. The element is now judged where it is **bound**,
  before the body runs, and the comprehension ends there whatever a later element would have decided. An
  ordinary `no_such_key` still short-circuits exactly as before — it is a fact about one datum, where a value
  that must be awaited says the host handed the engine something it cannot evaluate at all.

  A container is deliberately not walked: a thenable is refused where it becomes a value the engine reasons
  about, so `size(xs)` and `xs + [3]` carry it along while every way of reading the element out is refused.

  **A dotted chain whose ROOT alone is declared is read as the declared name.** The split over declared
  names started at two segments, so such a chain fell into the activation's prefix search: an activation
  holding both `a` and the literal key `"a.b"` answered the undeclared key at evaluation where the check
  had typed the declared name — the one outcome that split exists to prevent. The root now counts as a
  prefix, and where any prefix is declared the search never runs. The checker keeps its ordinary select
  path for a root-only split, because the nullable-access rule is a fact about an expression's shape
  rather than about which name it reads.

  **The conformance drivers gained the two things they were not asking.** An excluded row that checks
  clean is now held to the **recorded type** — an exclusion excuses a verdict and pins no type, so that
  branch compared nothing at all, and a fabricated row declaring `1 + 1` to check as `string` passed the
  gate. A per-group `typeDiffers` names the rows whose type differs, exactly as `offsetDiffers` names an
  offset. And an exclusion matched on a fact about a row's input (`disable_check`, cel-spec's value read
  with the check turned off) now has to be **true of the row**: it applies only where this engine really
  refuses at check, which moved nine rows cel-spec never contradicted into plain agreement and one row to
  the container reason that is its actual cause. Deferring a row to the check seam requires a correction
  over there rather than merely an exclusion.

  Also: the whole package type-checks under one gate (`check:types` over `src`, `tests` and `conformance`,
  where only `src` was covered before, and the conformance driver held a real error); unit tests for the
  converting lossy comparison, `int(double)` at **both** int64 extremes and a duration's
  `getMilliseconds` component, which only the replay pinned; and `value-equality.ts` now documents the
  rule it implements rather than the exact comparison it replaced.

  Still nothing consumes the package: `@marcbachmann/cel-js` serves the whole repository, and no manifest,
  consumer or module changes.

- 88fb651: `@telorun/cel` carries Telo's **function catalog** — the dialect a manifest is written in — as signature
  data plus implementations, so the engine holds the whole function surface an expression may call.

  `registerFunctionCatalog(environment, { handlers })` registers 67 functions over 86 signatures through the
  **public** `registerFunction`, with no privileged path of any kind: a host may leave the catalog out,
  replace a function, or remove a name, and a default environment has none of it.
  `src/signatures/function-catalog.json` is the declarations — every signature, the category and summary a
  listing prints, and whether a function is deterministic, host-backed or guards its literal arguments — and
  `functionCatalog()` is the one surface a `functions` listing reads, so a consumer never reconstructs it
  from registrations. Not one function in it is defined by cel-spec, which the file declares once rather
  than on each entry; the validator (`check:signatures`) refuses an entry that redeclares it, a signature
  with no implementation, and any signature answering the same call as a standard one — which registering it
  would silently replace.

  **Nine functions are the host's**: `sha256`, `md5`, `sha1`, `sha512`, `hmac`, `base64Encode`,
  `base64Decode`, `json` and `joinPath`, each needing a facility the package may not reach. One left out
  still registers, so a consumer that only ever checks still type-checks the call, and evaluating it answers
  an `unbound_function` error **naming the function** rather than a null or an empty string.

  **A refusal is the catalog's own words** — `<function>: <what is wrong>`, identical on every engine and
  never a library's or the host language's wording: an invalid pattern ends with one of RE2's own
  parse-error kinds and nothing after it, and `parseJson` words its own offset
  (`parseJson: invalid JSON at offset 3`). **And a refusal over a literal argument is now the CHECKER's**:
  a registration may carry a `checkArguments` guard (`LiteralArgumentCheck`), asked where the call resolves
  and reported as `CEL_INVALID_ARGUMENT` naming the call as written, so `fixed(1.0, 11)` is refused without
  running the expression. Twelve catalog functions carry one, and each runs the very code the evaluation
  runs, so the static and dynamic answers cannot drift.

  `string(timestamp)`, `string(duration)` and `int(timestamp)` are **not** in the catalog: all three are
  cel-spec's own and the standard library declares them, with the same call form, arity and return type.

  The catalog's behaviour is pinned by the conformance vectors, replayed in place: `catalog.json`'s 178 rows
  and `types.json`'s 26, every row answered or corrected against a cited authority, with 52 refusals and 28
  literal-guard diagnostics reproduced byte for byte — and both backends are now held to each other over
  every one of the 300 calls the registry holds, the catalog's 86 included.

  Three runtime dependencies, each pinned exactly because the vectors pin their answers: `re2js`,
  `d3-format` and `uuid`.

- 88fb651: `@telorun/cel` compiles an expression to **JavaScript source**, as a second backend over the same runtime
  as the closure one.

  `environment.emit(sources)` answers one module for a set of expressions — its `text`, its `key` and its
  integrity `header` — and `environment.emittedModule(sources, store)` reads it back from a store the host
  supplies, emitting and writing it where the store holds nothing usable. A host loads the text however it
  loads a module and calls `programsFromEmittedModule(loaded, module, environment.emitterRuntime())`, which
  verifies the module's header before a single function runs and answers one `CelProgram` per expression. An
  emitted program is faster by exactly one thing — what the closure calls cost — since both backends pay the
  same shared runtime underneath: measured on one machine over six runs, 1.20x-1.44x on expressions that
  call many small operations and a wash (0.99x-1.09x) on one dominated by a dotted-chain search and a
  conversion.

  **Both backends answer identically, case for case** — the same value, or the same error code and the same
  range. That is a property of the wiring rather than of the tests: everything around a call now lives once
  (`backend-runtime.ts`) — admitting a host value, the member read in every form, `has()`, a bool operand,
  an aggregate's optional entry, a name and a dotted chain, and the per-call-site overload dispatch with its
  bounded cache — and both backends call those functions by reference, so the only thing they compile
  differently is how control gets from one call to the next. It is gated three ways: every form of the
  grammar (with completeness over the tree's own node kinds), every one of the 214 calls the registry holds,
  and every one of the 1,814 conformance rows.

  **The runtime is injected, never imported.** The module's default export is a factory taking the runtime
  support library, and the text names no specifier of any kind — so it loads from a `data:` URL, from a
  cache directory mounted anywhere and under a host whose resolver is not Node's, and it cannot silently
  accept a runtime of another version. `RUNTIME_BINDINGS` is the whole contract. No CEL member read is a
  host property access: `a.b`, `a['b']`, `a[expr]`, `.?`, `[?]` and `has()` all emit a call to the member-read
  seam, and the only properties the emitted code reads at all are six of the engine's own structural fields.
  Nothing is asynchronous, and nothing touches a filesystem: the engine exports one store seam and no
  loader.

  **The cache key covers the environment, not just the source**: the emitter's format generation
  (`EMITTER_FORMAT_GENERATION`, bumped on any change to the text the emitter writes for any tree), the
  engine version (`ENGINE_VERSION`, generated from the telo version line at `prepare` and gitignored, as the
  analyzer's surface generation already is), the environment's digest and the ordered list of expression
  sources. The digest is over the environment's **resolved listing** — every surviving function signature,
  every named type, every variable, every namespace, every option — so two environments built by different
  registration orders are one key while a host that replaced or removed a standard function is a different
  one.

  **The integrity header inside the module carries five fields**, because the three provenance ones are
  byte-identical for every module one engine writes against one environment and so distinguish only a shared
  cache root and a stale environment: `format`, `engine`, `environment`, plus `key` (the module's own
  identity) and `body` (the digest of every byte after the header line, which covers the `integrity` export
  and therefore cannot live in it). Every mismatch a stored **text** shows is a recompile naming itself under
  `refused` — another key's text, a text truncated after its header, a text edited after it was written; a
  loaded **module** that declares nothing, declares another key, exports no factory or answers the wrong
  number of functions is refused with `CelEngineError` code `emitted_module_rejected`. A store's write should
  still be atomic — written elsewhere, then renamed — because several hosts share one cache root: that is how
  a half-written entry is avoided, and the body digest is how one is detected if it is not. Verifying a
  stored 838 KB module (1,771 expressions) costs 9-15 ms against 29-39 ms to emit it, and a store hit now
  parses nothing.

  Emission is deterministic: the same expressions in the same order against the same environment are the
  same bytes.

- 3dd7be0: New package `@telorun/cel`, on the telo version line: the CEL language front end. It reads an expression into a canonical tree whose every node carries its `[start, end]` source range, writes any tree back to source that re-reads as the same expression, and answers two questions about a tree — the names it reads from its environment, and the namespaced functions it calls.

  Reading never throws: a malformed or half-typed expression gives a tree for the longest prefix that read plus one ranged diagnostic, so an editor can complete a member after a dot. A qualified call (`Alias.fn(x)`) is a `qcall` node produced by a total tree pass that takes the namespace set — never by the parser, because `Alias.fn(x)` and `obj.method(x)` are one syntax — and an expression records the set it was resolved under. Macro calls stay ordinary calls. `cel` and `optional` are refused as namespaces. The five input limits (100000 nodes, 250 deep, 1000 list elements, 1000 map entries, 32 call arguments) are enforced as ordinary diagnostics.

  Nothing consumes it yet: `@marcbachmann/cel-js` still serves the whole repository, and no manifest, controller or consumer changes.

- 88fb651: A namespaced call is judged **only against what the host declared**, and a host may now declare less than
  a whole signature. Two capabilities, each making a withholding structural rather than a flag:

  **A namespace may be OPEN** — `registerNamespace(name, declarations, { open: true })`. A name it did not
  declare then types `dyn`, is **listed as a call**, and is reported by nobody. A host whose name resolution
  rests on vocabulary this engine may not learn — an export gate, a capability, a re-export chain — resolves
  such a name itself and words that verdict itself. Closed stays the default, where an undeclared name is
  `FUNCTION_UNRESOLVED` as before. Openness is per namespace, is inherited by a `clone()` and may be
  withdrawn by re-registering, and it **enters the environment digest**: it decides whether an expression
  checks clean, so two environments differing only in it must not share an emitted module.

  **A declaration may WITHHOLD its parameter list** — `{ name, returns }` beside the existing
  `{ signature }`. The call's result is typed and its arity and argument types are judged by nobody here, so
  a host whose own signature grammar is richer than CEL's — an optional trailing parameter, a declared JSON
  Schema per parameter — judges them itself and strictly better. The two forms are exclusive **by
  construction**: there is no way to supply parameters and ask for them not to be judged, because that shape
  would let a declaration carry a list nothing reads, which no reader can tell from a list that is simply
  wrong. A withholding declaration still carries `deterministic`, `hostBacked` and `throws`, and is listed
  as `total(…): double` rather than as a function of no arguments.

  Both exist for one reason: judging a call against a declaration the host did not make leaves the host one
  move — suppress the verdict — which is the after-the-fact classifier this engine exists to retire. The
  engine declines the question instead of answering it wrongly and being overruled. `NamespaceListing` gains
  `open`, so a consumer reading the definitions sees it.

- 3dd7be0: `@telorun/cel`'s schema conversion stops typing anything `dyn` in silence.

  A schema node that was a `$ref`, or that composed with `allOf`, was unjudged: the reader handled
  `type`, `properties`, `items`, `anyOf` and `oneOf` and **fell through to `dyn`** for everything else. A
  variable typed through a reference therefore kept exactly the behaviour deep typing exists to end — a
  typo two levels in survived. The finding was never "`$ref` is unimplemented"; it was "an unread keyword
  silently becomes `dyn`", so the rule is now that **nothing a schema says may fall through silently**, and
  the four parts below are what implements it.

  **References split at the document boundary.** The conversion's input is a node **plus the document it
  belongs to** (`{ schema, document? }` on a registration), the document travelling with the node as the
  descent moves between documents. A document-local reference (`#/$defs/…`, `#/definitions/…`) is resolved
  by the engine against the document in hand. A reference that **leaves** the document is answered by the
  one host resolver the engine already consults at every node, whose answer widens from "a registered type
  name with arguments" to "that, **or the document to read in place of this node**"; the resolver is handed
  the node and its document, because which document a reference outside this one resolves against — and how
  a relative one is rebased — is the host's own rule. No second seam, and no copy of the host's registry
  inside the engine.

  **`allOf` intersects**, and so does everything else one node says about its own type: records merge
  field-wise and a narrower scalar wins, so a reference beside a `properties` block, or two partial
  records, compose — a field of each half reads and a third is `CEL_UNKNOWN_FIELD`. **`enum` and `const`
  with no `type` are read from their values' JSON types**, which is what makes a constant beside a
  host-typed branch a `string` rather than a `dyn` that collapses the whole union.

  **The conversion reports every node it could not judge**, each by JSON Pointer beside the type it
  produced (`schemaReports()` on an environment), with one reason from a closed set: `keyword-not-read`,
  `shape-not-read` (a tuple `items`, a `type` naming no JSON type), `reference-unresolved`,
  `intersection-empty`, and `named-type-unregistered` — the host's resolver naming a type nothing is
  registered under, the host disagreeing with itself, which the structural reading used to paper over
  silently. It **reports rather than refuses** because such a node is usually a third party's
  data — a schema shipped inside something a host merely loaded — so throwing at registration would turn
  someone else's schema into a crash, while typing it `dyn` quietly is the hole itself. A node beyond the
  conversion's own document carries the pointer of the reference that led out of it, so a consumer anchors
  at a line it has.

  Completeness rests on an **engine-owned closed list of the keywords that can change what CEL type a node
  has**: one the reader does not read is reported, and a node carrying none of them says nothing about its
  type and is `dyn` legitimately. A keyword that constrains a _value_ rather than its type (`required`,
  `contains`, `propertyNames`, `format`, every bound) is deliberately off the list. The list and the reader
  are held to each other in both directions, with the mechanism's own blind spot written down beside it.

  A reference **re-entered** on the descent — a recursive schema — is the one deliberate `dyn`, declared as
  such rather than reported: the descent terminates and the outer reading is what the consumer gets. A
  shape referenced a hundred times still converts once, and the cost bound is measured on a fixture whose
  every level is reached through a reference and merged out of two `allOf` halves.

  Still nothing consumes the package: `@marcbachmann/cel-js` serves the whole repository, and no manifest,
  consumer or module changes.

- 3dd7be0: `@telorun/cel` evaluates: the semantics, the value domain and the eval-free closure backend.

  **Every operator, conversion and standard function behaves as cel-spec requires**, and lives exactly
  once (`runtime-library.ts`, keyed by the dispatch key the registry resolves on, with the declarations
  staying data). `int` is a `bigint` and an overflow is an **error rather than a wrap**; `uint` and
  `double` are distinct; division and modulus by zero are two different errors; bytes and strings are
  distinct and both are ordered; an instant is nanosecond-precise and its getters take a zone — an IANA
  name or a fixed `HH:MM` offset; `matches` is **RE2**, so a pattern the host's own engine would accept and
  RE2 would not is refused rather than silently matched. `int(duration)` is there too, which no conformance
  row pins.

  A duration's `getMilliseconds()` answers the **component** (321 for `123.321456789s`), as a timestamp's
  always has, rather than the total; `int()` refuses a double **at or beyond either** int64 extreme; and the
  engine's **one comparison** converts across the numeric types the way cel-spec's does — the sign decides
  where the double lies outside the integer's range, and otherwise two doubles are compared, lossily, so
  `dyn(9223372036854775807) < 9223372036854775808.0` is `false`. A map's key identity is **not** that
  comparison and does not convert.

  **A duration is the signed 64-bit range of its total nanoseconds** —
  `-9223372036.854775808s … 9223372036.854775807s`, roughly ±292 years — which is cel-spec's own limit,
  stated under _Overflow_ in its language definition and read by all six of the vectors'
  `timestamps/duration_range` rows. It is checked at every point a duration is built: the conversion,
  duration `+` and `-`, `timestamp - timestamp`, and the duration operand of `timestamp ± duration`. That
  range is a **subrange** of `google.protobuf.Duration`'s ±10,000 years, which Telo's typed frame keeps
  deliberately so that a duration arriving from a transport, a journal or a controller is always
  representable — so `duration('200000000000s')` is a value the frame carries and CEL cannot construct.
  Nothing about the frame, the plain encoding or the value-type entries changes.

  **Eight string declarations are named as not CEL's**, taking the library's `"spec": false` count from 11
  to 19: `indexOf`, `lastIndexOf` and `substring` in both arities, `lowerAscii` and `upperAscii`.
  cel-spec's standard definitions over strings are exactly `size`, `startsWith`, `endsWith`, `matches`,
  `contains` and concatenation; everything else is the strings extension's, which Telo does not ship. Each
  reason names that authority, the extension that has the equivalent, and **where this member differs from
  it**: the three index-taking members index by **UTF-16 code unit rather than code point** — a port
  reading them as the extension's would index by rune and silently change the answer of every manifest
  that cuts a string — and `lowerAscii` / `upperAscii`, despite their names, apply the host language's own
  casing rather than touching the ASCII letters alone. `trim`, `split` and `join` keep their entries with
  their own differences stated.

  **A CEL error is a VALUE that participates in short-circuit.** `false && <missing key>` is `false` and
  `true || <missing key>` is `true`, whichever side the error is on, so every operator, comprehension step
  and conditional carries an error-valued operand through; an error that survives to the top of an
  evaluation becomes a thrown `CelEvaluationError` carrying one of the closed `CEL_EVALUATION_CODES` and
  the range of the text it is about. Thrown where it was found, the short-circuit rules would be
  unimplementable.

  **Evaluation is synchronous on both backends.** A registered implementation's return type is not
  thenable, so an asynchronous one does not compile; a thenable that reaches evaluation anyway is
  `async_value_unsupported` with a range, never a value passed along.

  **A value says what it is by a string type key** under `Symbol.for("telo.cel.value")`, never by its
  constructor: two copies of the engine agree about a value either of them built, and a key that cannot
  appear in parsed JSON means an inbound body cannot forge a duration — a plain object carrying a
  string-keyed look-alike brand is data, and reads as a map. What is plain carries no key (`null`, a
  boolean, a string, a double, a `bigint` int, `Uint8Array` bytes, an array, a string-keyed plain object);
  the closed `CEL_VALUE_KEYS` cover what has no faithful plain form — a uint, a timestamp, a duration, a
  type value, an optional, a map with typed keys, and an error. A host's named type declares its own key
  and a collision is refused at registration.

  **The type a check REPORTS substitutes `dyn` for an unresolved type parameter**, which is the last step of
  the rule the checker already applied to every use of one: `[]` is `list` and `optional.none()` is
  `optional<dyn>`, while a parameter survives where it is declared — a signature's text, a nominal type's
  parameter list. And **a dotted chain splits once**, over the names the host declared, through one function
  the checker and the backend share: a declared chain is split at compile time, so evaluating it is one
  activation read rather than a search, and a declared name the activation does not hold fails for that name
  instead of quietly reading a shorter prefix.

  **Every member read goes through one lookup** over the value's own entries — `a.b`, `a['b']`, `a[expr]`,
  `.?`, `[?]`, a macro's field read and `has()` alike — so no key, however it was computed, reaches a
  prototype, a method or a function property: `a['length']` on a map is a missing key and
  `a[request.query.k]` cannot reach `constructor`. A missing key is the `no_such_key` error value, an index
  into a list is bounds-checked, a select on something that holds no members is an error, and **a CEL map
  is built prototype-free**, so `__proto__`, `constructor` and `prototype` round-trip as data.

  **The closure backend uses no `eval`, no `new Function` and no disk**: a tree compiles into nested
  closures over the runtime library, with everything an expression's shape decides settled at compile time.
  Macros lower there and in the checker from one binding table — `has`, `all`, `exists`, `exists_one`, `map`
  in both arities, `filter`, `cel.bind`, `optMap` and `optFlatMap` — and there is still no comprehension
  node, so the tree stays writable back to source. Overloads are resolved on the values' own types per call
  site, because `dyn` reaches the runtime and `dyn(1.0) == 1` must answer `true`. `qcall` dispatches through
  a table the host binds per evaluation; one nothing binds is `unbound_function`. Every in-process cache is
  bounded with a declared capacity, and **every registration forgets what the environment compiled**, so a
  replaced function cannot be served from a cached program.

  Two corrections to what the front end read. A **bytes literal holds the UTF-8 of its text** — `b'ÿ'` is
  `0xC3 0xBF`, not `0xFF`, which is cel-spec's answer and the only reading under which `b'ÿ' ==
b'\303\277'` holds; and **namespace resolution answers without walking** where no namespace is
  declared, which is every site that has none.

  The conformance vectors are now replayed at the **value** level as well as the check level, with the
  completeness invariant the check-level one cannot have: per row, the engine either answers what the row
  records, or answers cel-spec — verified against the row's own `deviation.celSpec`, so a correction is
  evidence rather than an exemption — or stands on the recording with a reason; a row on none of those
  fails the gate — in **both** directions: a row cel-spec answered must be listed whichever way the engine
  went, because a `matched` bucket that never consults `deviation.celSpec` counts following the recording as
  agreement. 1,814 rows: 1,065 answered as recorded, 120 corrected against cel-spec, 625 excluded with a
  reason, 4 answered by the check-level driver, 0 unaccounted —
  and six of them, the rows whose recorded error text the format owns rather than the replaced engine,
  reproduced **byte for byte**, caret included. The check-level `extension-library` exclusion is narrowed
  to the rows whose call the engine does not resolve, so the `string_ext` sections whose members this
  library declares are compared like any other row: 608 → 547 excluded, 1,043 → 1,097 checked to the
  recorded type. A corrected row is held to the type its own `deviation.celSpec` records, and the
  round-trip assertion is outside the correction suppression — a correction is about a verdict, not a
  licence to stop serializing.

  `CEL_NULLABLE_ACCESS` now matches today's **subjects** as well as today's three guards: a chain rooted at a
  name the expression itself bound is not a subject, so `xs.map(e, e.code)` over a nullable element is not
  reported — reporting it would newly reject a manifest that checks today. And every door a host value comes
  through is checked for a thenable, the member read included (`resources.<name>.status.<field>` is that
  shape), so a promise nested in a host value is `async_value_unsupported` rather than a value handed on.

  Still nothing consumes it: `@marcbachmann/cel-js` serves the whole repository, and no manifest, consumer
  or module changes. The package gains its first runtime dependency, `re2js`, pinned exactly as templating
  pins it, because CEL's pattern language is RE2.

- 3dd7be0: `@telorun/cel` gains its registry and its type checker.

  **Nothing in the registry is privileged.** The standard library registers through the surface a host
  uses, the dispatch key is a call's name, form and parameter types rather than its return type, and
  removal is by the same key — so a host can replace `duration(string)` with a signature of its own, or
  remove a standard function and have a call to it report `CEL_UNKNOWN_FUNCTION`. An environment clones,
  inherits everything and then diverges. The library itself is data (`src/signatures/standard-library.json`,
  documented and validated by `check:signatures`), because a port in another language must inherit the same
  surface rather than re-type it.

  **JSON Schema is the checker's native input, read to full depth**: nested objects, element types, and
  unions carried as unions rather than collapsed, so a typo two levels into a schema-typed variable is a
  ranged `CEL_UNKNOWN_FIELD`. A flat field map is still accepted, so a host can type exactly as shallowly
  as it must. A schema is converted once per registration, so checking does not get more expensive as a
  schema gets deeper.

  **A named type is not its base.** `registerType` registers a name over a base with its own operators,
  comparisons, conversions, members and invariant type parameters; a plain value of the base is refused at
  its slot, and a differing type argument is `CEL_TYPE_ARGUMENT_MISMATCH`. A host's vocabulary enters
  through that and through one schema resolver, consulted at every schema node before the structural rules.

  **Every verdict is decided by the checker, with a source range**, and nothing reads another component's
  message: `CEL_SYNTAX_ERROR`, `CEL_TYPE_ERROR`, `CEL_UNKNOWN_IDENTIFIER`, `CEL_UNKNOWN_FIELD`,
  `CEL_UNKNOWN_FUNCTION`, `CEL_WRONG_CALL_FORM`, `CEL_TYPE_ARGUMENT_MISMATCH`, `CEL_NULLABLE_ACCESS`,
  `CEL_INVALID_ARGUMENT`, and `FUNCTION_UNRESOLVED` / `FUNCTION_ARITY_MISMATCH` /
  `FUNCTION_ARGUMENT_MISMATCH` for a namespaced call. A fix is a whole-source replacement. Nullable-access
  guards are exactly `?:`, `&&` and `||`. A tree resolved under one namespace set and checked against
  another is refused with `namespaces_mismatch` rather than checked.

  The library is **CEL's**, held to cel-spec rather than to any engine's behaviour: the conversions
  (`int(uint)`, `int`/`string` of a timestamp or a duration, the identity conversions), ordering over every
  scalar type including bytes, a concatenation whose element type is the one both sides hold, `has()` over
  any member read, an unresolved type parameter behaving as `dyn` wherever it is used, and the optional
  library whole — `.?`, `[?]`, `of`, `none`, `ofNonZeroValue`, `hasValue`, `value`, `or`, `orValue`,
  `optMap`, `optFlatMap`, equality over optionals and `optional_type`. A declaration CEL itself does not
  define carries `"spec": false` with a required reason, which the validator gates in both directions;
  eleven do.

  The grammar closes its cel-spec corners too, each of which the engine being replaced refuses: a **member
  name between backticks** (`request.headers.`` `content-type` ``) typed against a schema's `properties`
exactly as a plain member is — without it, every dashed or dotted key in a header map, a JSON payload or a
column set is unreachable by the type checker; **raw bytes literals** (`br`, `bR`, `Br`, `BR`; `rb` is not
one); **`[?x]`and`{?k: v}`** under `enableOptionalTypes`, the entry holding an `optional<T>`and
contributing a`T`; a **double that begins with its point** (`.99`); and an **absolute name** (`.y`),
resolved against the environment's declarations and never against a name the expression bound — the only
spelling for an outer name where a comprehension variable shares it. A **dotted declaration is one name**,
the longest prefix winning: declare `a.b.c`, or `a.b`, or both, and `a.b.c` reads whichever the host
  declared.

  Also: the per-call resolved-signature listing carrying determinism, host-backedness and throws — derived
  from the checker's lowering, so a macro is not listed — and a query for whether a type converts to text.

  Still nothing consumes it: `@marcbachmann/cel-js` serves the whole repository, and no manifest, consumer
  or module changes.
