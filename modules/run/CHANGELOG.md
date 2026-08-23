# Changelog

## 0.26.0 - 2026-08-23
### Added
* Drops the retired `teardown()` from the surface: ai's model, image and embedding handle interfaces no longer declare it, and the run and vector-store-pgvector controllers no longer implement an empty one. Cleanup is what a controller returns from `init()` / `run()`. Nothing called these, so no behaviour changes; a third-party handle implementing `teardown()` simply has a method nobody invokes.

## 0.25.0 - 2026-08-20
### Added
* A dispatch site's retry policy gains nonRetryable: a list of error codes that end the loop at the first failure instead of consuming the budget, which for a non-idempotent target is the difference between one side effect and N. And a step gains a per-attempt timeout: (milliseconds), enforced by cancellation rather than by abandoning the call, failing ERR_STEP_TIMEOUT on elapse.
* A step's decisions are recorded when the body runs inside a durable region: resolved inputs, branch predicates, loop conditions, switch keys and pure value steps. Recording only the results would leave a resume free to re-derive a decision from a live reading and take a branch the run never took. Outside a durable run nothing changes and nothing is paid — the step engine journals only when a run handle is ambient.
* Any kind can now carry a step body: the grammar is a shared fragment (`$ref: "telo://manifest#/$defs/Step"`) instead of four `$defs` copies declared here, and `StepEngine` moved to `@telorun/sdk`. Two breaking consequences: `while/do` is now legal in an iteration, projection and loop body, not only a sequence; and reading the grammar requires telo >=0.79.0, which the module now declares.
* Work can now wait — for a duration, until a time, or for a value delivered from outside — and the process is free to exit while it does. Durable.Sleep, Durable.Await and Durable.Value are backend-neutral and name no engine; DurableLocal.Deliver, Status, Result, Cancel, Schedule and Resume address a run from outside. A start no longer blocks: it records the run and returns its id, and Result is how a caller that wants the outcome asks for it, with an optional wait. Waiting inside a region that declares it cannot be held open — a transaction, a lease — is refused at telo check and at runtime, quoting both the region's promise and the wait's reason. A wait inside a concurrent fan-out parks its own branch and lets its siblings finish.
### Fixed
* A nested step body now records under the step that dispatched it instead of restarting at the root. Two nested bodies with a same-named step shared one key, and first-writer-wins handed the second the first's result — with no mismatch to detect when both dispatched the same target. The dispatching step's path rides the invocation context, so a nested body's keys hang under it and a crash inside one resumes inside it. Also: a run whose process was cancelled is left interrupted rather than settled as failed, so it stays resumable — settling it terminal made every crash produce an unrecoverable run, from the one feature whose purpose is surviving crashes.

## 0.24.1 - 2026-08-16
### Fixed
* Controllers ship as one bundle per module, selected by PURL fragment, and a module-owned library is resolved at load through the import graph instead of being copied into each dependent's bundle. A shared source file compiled into two bundles was two module scopes, so state a module kept beside its instances silently became two of them.

## 0.24.0 - 2026-08-16
### Added
* A step's `retry:` now actually retries. It was declared on four kinds and honoured by nothing — passed to `ctx.invoke` on one of the step leaf's four dispatch branches, and read by no kernel path, so a `!ref` step (the dominant shape) silently got one attempt. It is implemented in the leaf, where every branch passes through, and takes `Http.Request`'s field names — attempts, initialDelay, factor, maxDelay, jitter — because two spellings of backoff in one standard library make the word change meaning with where it is written. `delay` is kept as the older duration-string spelling, and a malformed one now fails `telo check` against a declared pattern instead of silently becoming a different backoff. A domain failure is retried; a cancellation and a contract violation (ERR_INPUT_INVALID and friends) are not, the latter because it is a property of the manifest and fails identically on every attempt. Every field declares its default in the schema, so the editor and a second-language step leaf read the same numbers rather than re-deriving them. The wait between attempts is cancellable — Sequence, Iteration, Loop and Projection now forward the InvokeContext they are handed into the step leaf, where a backoff is the one interval the kernel's own pre-dispatch cancellation gate cannot see. The failure that caused the wait rides on the cancellation as `data.pendingFailure`, so stopping mid-backoff does not lose the error being retried. A step's shape is now the kernel's own dispatch site (`telo://manifest#/$defs/InvokeStep`) rather than four hand-copied schemas, which is what removed 280 lines from this manifest and made `retry:` mean one thing everywhere it is written.

## 0.23.0 - 2026-08-15
### Added
* Run.Iteration accepts a stream as well as an array, pulled lazily under the existing concurrency, so a source too large to hold in memory can be iterated. `items` is bound only for a materialized collection - under a stream the only value it could hold is the cursor the loop is pulling from, and passing that to a step would drain the loop's own source and end it early with nothing to notice.
### Fixed
* Run.Loop's `iteration` and Run.Iteration / Run.Projection's `index` are declared `type: integer`, but crossed into CEL as JS numbers and so typed as doubles. `iteration + 1` type-checked statically and then failed at dispatch with "no such overload: dyn<double> + int", pushing authors to `double(...)` or `int(...)` casts a CEL int64 should never need. They cross as BigInts now.## 0.22.0 - 2026-08-09
### Added
* metadata.name is now Run, so the module contributes its kinds under the `Run.<Kind>` canonical prefix instead of `run.<Kind>` — a name rather than a slug, in the PascalCase form the manifest grammar asks for. Importers are unaffected: a kind is always written through the import alias the consumer picks (`<Alias>.<Kind>`), and the `exports.kinds` list is unchanged. Only a manifest that names the canonical `<module>.<Kind>` form directly — a legacy bare-string `x-telo-ref`, or a diagnostic matched by its text — sees the new prefix.## 0.21.0 - 2026-08-08
### Added
* Every `x-telo-ref` slot now declares what this module does with the target: `use: dependency` (held and read), `call` (control transfers during the invocation and returns), `detached`, `trigger.inbound`, `trigger.consumer`, or `schema` for a slot that only names a shape. Slots that accepted `Telo.Invocable | Telo.Runnable` through an `anyOf` now say `Telo.Executable`, the new built-in parent of both. Wiring manifests are unchanged — this is schema metadata, and it is what lets `telo check` answer whether control reaches a referenced resource, and when.## 0.20.0 - 2026-08-03
### Added
* Named CEL bindings and pure steps. Run.Value and Run.Choice take an optional `bindings:` map — name → CEL, read by bare name inside the kind's expressions and inside each other. Order is derived from what each expression references rather than declared, so reordering rows cannot change behaviour; evaluation is lazy and memoised per call, so a binding several decision rows share is computed once and one nothing reads is never computed at all — a binding means exactly what inlining its expression would. A cycle is BINDING_CYCLE and a name that shadows something already in scope is BINDING_NAME_RESERVED, both at `telo check`. Bindings are evaluated before any step runs, so they never see `steps.*`: for an intermediate derived from a step's result, a step now carries `value:` instead of `invoke:`. That pure step publishes `steps.<name>.result` like any other but dispatches nothing — no resource, no span, no topology node — and is part of the shared step grammar, so it works in Run.Sequence, Run.Loop, Run.Iteration and Run.Projection alike; a failure inside one is reported against the step by name, as every other step form already is. Binding names must lex as CEL identifiers, so a name no expression could ever read is rejected at `telo check` rather than silently dead.## 0.19.0 - 2026-08-01
### Added
* The controller now ships inside the module artifact as a bundle (pkg:telo/local/js) instead of being fetched from npm at load. Importing this module needs no npm registry at run time, and its version is a single number again: metadata.version. The kernel builds the controller from source while the module is a working copy, so a checkout needs no build step.## 0.18.0 - 2026-07-31
### Added
* Update controller @telorun/run to 0.13.0.
* Data shapes are declared with the kernel built-in `Telo.JsonSchema` instead of `Type.JsonSchema`, so the module no longer imports `std/type` to describe its own contracts. Identical behaviour; `Type.JsonSchema` still resolves for anyone who prefers it, though the `type` module is now deprecated.## 0.17.0 - 2026-07-29
### Added
* Update controller @telorun/run to 0.12.0.## 0.16.0 - 2026-07-29
### Added
* Update controller @telorun/run to 0.11.0.## 0.15.0 - 2026-07-27
### Added
* Reference slots name their target as an alias-qualified kind (`<Alias>.<Kind>`, `Self.<Kind>`, `Telo.<Kind>`) instead of the `<namespace>/<module>#<Kind>` identity string, so a constraint resolves through this module's own `imports:` map and stays pinned to the version it imports. `metadata.namespace` is dropped — a module's location is the ref it is published under, never anything it declares about itself.## 0.14.1 - 2026-07-27
### Fixed
* Rewrite the library and kind descriptions for the hub's semantic search: each one now states what it does in a single paragraph, without kind names, references to the modules that implement it, or wording that only made sense against the module's history. The README is corrected alongside: reference and CEL syntax the analyzer no longer accepts, unpinned version tags, and examples that named fields or kinds that do not exist.
Declare `metadata.categories` — the domain labels the hub groups its browse view by and the editor filters its resource picker with.## 0.14.0 - 2026-07-27
### Added
* Update controller @telorun/run to 0.10.0.## 0.13.0 - 2026-07-19
### Added
* Declare repository and license in module metadata, published as org.opencontainers.image.* annotations on OCI.## 0.12.0 - 2026-07-12
### Added
* Describe exported resource kinds via metadata.description for semantic discovery.## 0.11.1 - 2026-06-24
### Fixed
* Update controller @telorun/run to 0.9.1.## 0.11.0 - 2026-06-20
### Added
* Update controller @telorun/run to 0.9.0.## 0.10.0 - 2026-06-14
### Added
* Update controller @telorun/run to 0.8.0.## 0.9.0 - 2026-06-13
### Added
* Update controller @telorun/run to 0.7.0.
* Add Run.Value: a declarative invocable that returns a CEL-evaluated value (or a constant), replacing Js.Script for pure value shaping.## 0.8.0 - 2026-06-07
### Added
* Update controller @telorun/run to 0.6.0.
* Step `invoke` examples reference resources with the unified `!ref` form.## 0.7.0 - 2026-06-06
### Added
* README: bringing up dependencies with a sequence's with:/targets: (a Run.Sequence can start an Http.Server or DB for its steps); targets is not Application-only.## 0.6.0 - 2026-06-06
### Added
* Clarify Run.Sequence inputs/outputs docs — inputs declares the input contract (JSON Schema map, {} = dyn), outputs is the CEL map producing the caller-visible result. Adds a schema example and a "Sequence as an HTTP handler" README example.## 0.5.0 - 2026-06-05
### Added
* Update controller @telorun/run to 0.5.0.## 0.4.1
