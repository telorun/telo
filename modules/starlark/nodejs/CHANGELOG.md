# @telorun/starlark

## 0.5.0

### Minor Changes

- 2ee3598: A resource's declared invocation contract is now enforced.

  `inputType` / `outputType` were declared all over the standard library and read almost nowhere: a declared `default:` never applied, a misspelled input, a wrong-typed value and a misread result field were all silent, and three modules of roughly forty validated anything at all — each re-deciding it for itself. Underneath was a naming collision: `inputs:` meant _a schema_ on the six `modules/run` kinds and _values_ at every call site, so the run kinds' whole declared contract was inert.

  One invariant now holds everywhere: **`inputs`/`outputs` are values; `inputType`/`outputType` are schemas.** The normative rules are in `kernel/specs/invocation-contract.md`.

  **Resolution.** A shared resolver answers "what is this target's contract" for both halves — `telo check` and the runtime — layering the instance's own declaration over the kind's. A kind's contract resolves to the **nearest declaration along `extends`** and **replaces** rather than merges: config and observed state merge because construction and reported state are additive, but a call signature is not, and merging a child's required inputs into its parent's yields a union no caller can satisfy. This also fixes multi-level chains, which previously resolved to nothing.

  A child that inherits its controller and declares its own contract must bridge it — `inputType` needs `inputs:`, `outputType` needs `result:` — because the inherited controller understands only the shape it was written for. That combination used to pass `telo check`, run, exit 0 and do nothing at all.

  **Enforcement.** The kernel binds the resolved contract to the instance at creation, so **an instance is never observable unbound**. Enforcing at a handoff would have meant enforcing at every handoff — injection, explicit resolution, scope handles, template dispatch, the chokepoint — and the dominant path is injection: a consumer reads the reference off its own config and invokes it directly. `invoke` and `provide` are bound; `run()` is parameterless and void, so a resource whose contract requires inputs is rejected statically at a run site. Defaults are filled and both directions validated on every call, skipping `x-telo-stream` properties in **both** directions.

  Violations raise the ambient `ERR_INPUT_INVALID` / `ERR_OUTPUT_INVALID` as structured errors: catchable and typo-checked by name in a `catches:` block, never counted toward a kind's own declared union. `JS.Script`, `Starlark.Script` and `Run.Choice` drop their controller-side validators, and `Run.Choice`'s duplicate `ERR_OUTPUT_INVALID` declaration goes with them; `Image.Blank`, `Image.Overlay`, `Pdf.Rasterizer` and `Pdf.FormFields` drop the input guards that duplicated their own declared bounds, keeping only what a schema cannot express (a CSS colour's validity, a PDF's decodability, a page against the document's real page count).

  **`Telo.JsonSchema` is now a kernel built-in.** Declaring a data shape stopped being optional once any kind can carry a contract: writing `inputType:` should not require an import, and a library declaring its own contract should not import a module purely to describe itself — the same reasoning that keeps the mandatory log sinks in the kernel. `modules/type` is deprecated and unchanged, so `Type.JsonSchema` and every published manifest importing it keep working; the standard library, examples and templates now write the built-in and have dropped the import.

  The six `modules/run` kinds declare `inputType:` / `outputType:` in place of the `inputs:` property map, and each result slot is annotated `x-telo-value-schema-from: outputType` so every branch is checked statically — including ones no input selects. Consumers in this repo are migrated; a manifest pinning a published `run` by digest keeps the old spelling and keeps working.

  A `Telo.JsonSchema` rule's declared `code:` now reaches a `catch` block. Rules raise an error that carries a code but not the marker a catch matches on, so `error.code` was the generic plain-failure code and every `catches:` entry naming a rule code silently never matched — the behaviour `modules/type` has always documented was never the behaviour. Contract enforcement re-raises a rule failure structurally, preserving the author's code; only a structural schema failure becomes the ambient contract code.

  CEL evaluates an integer literal to a BigInt, which a JSON Schema validator does not accept as `integer` — so with enforcement on, every computed integer reaching a declared integer input would have been rejected for a reason no author could act on. Validation runs against a view where those read as ordinary numbers while the callee still receives the original values, and `Assert.Equals` no longer throws while rendering one.

  `Type.JsonSchema` is now a controller-less `extends: Telo.JsonSchema` alias rather than a second copy of the same controller, so the deprecated module has no implementation left to drift.

  **Statically**, `telo check` now validates each call site's `inputs:` against the target's contract, rejects an unmapped contract replacement, rejects a contract-requiring resource wired where the caller cannot supply arguments, and rejects a contract naming a type that is not declared in scope — which the runtime would otherwise only discover at the first dispatch through it, and which was invisible on a KIND because `Telo.Definition` is excluded from ordinary reference validation.

  Several latent bugs surfaced and are fixed. A wrapped `invoke` dropped every argument after the first, discarding the InvokeContext — so a detached body never observed cancellation and anything holding a resource across it was never released. `base:` validation demanded `metadata` and then rejected it, making any `base:` child of `JS.Script` impossible. The canonical type-schema id carried a URI authority (`telo://<module>/<Type>`), which no JSON Schema validator can resolve, so a `$ref`-based contract was uncompilable; the internal id is now authority-free, with the authored form unchanged.

  CEL placeholder substitution — how the checker avoids judging a value it cannot know — gained the same discipline: bounds it ignored (`exclusiveMinimum`, `minLength`, `minItems`, `required`, `allOf`-inherited constraints) are now honoured, a `oneOf` / `anyOf` is resolved to the single branch a value is written against so leaves underneath are typed rather than nulled, and a finding located AT a substituted path is dropped outright — a `pattern`-constrained string cannot be satisfied by any stand-in, so the checker declines to judge it. Structural findings survive, because they are located at the container.

## 0.4.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.4.0

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.3.0

### Patch Changes

- be79957: Move `@telorun/sdk` to `peerDependencies` across the kernel, analyzer, templating, and every module.

  The SDK carries the `Stream` class registered with `@marcbachmann/cel-js` for stream-typed CEL values. cel-js identifies object types by constructor identity, so a second copy of `@telorun/sdk` in the install tree silently breaks streaming-typed evaluations with `Unsupported type: Stream`. The contract was previously enforced with three layered mechanisms (a generated `dist/generated/runtime-deps.json` driving install-root `dependencies`, `overrides` + `pnpm.overrides` blocks, and a `globalThis`-keyed singleton in `stream.ts`); the build artifact silently degraded when the kernel was run without a build step, defeating the layering.

  The new shape:

  - Every package that imports `@telorun/sdk` declares it as a `peerDependency`. Consumers (the kernel's install root, the CLI, apps) provide a single copy and `peerDependencies` cause npm/pnpm to resolve every transitive import to it.
  - The kernel's `NpmControllerLoader` no longer reads `runtime-deps.json`; the realm-collapse name list is a hardcoded constant (`REALM_COLLAPSE_NAMES = ["@telorun/sdk"]`) in `npm-loader.ts`. The install-root `package.json` it writes drops the `overrides` and `pnpm.overrides` blocks — peer-dep resolution makes them redundant.
  - `scripts/generate-runtime-deps.mjs` and the generated artifact are removed; `scripts/prepack-bake-overrides.mjs` no longer chains the runtime-deps regeneration.
  - The `globalThis` singleton in `sdk/nodejs/src/stream.ts` is **kept** as a safety net for environments that still end up with mismatched SDK copies (e.g. a controller install from a tarball that predates this change).

  Consumers installing `@telorun/kernel` or any module directly must now ensure `@telorun/sdk` is present in their dependency tree. The kernel already lists it via the install root for any manifest it boots, so kernel-driven usage is unaffected.

- Updated dependencies [849f57a]
- Updated dependencies [be79957]
  - @telorun/sdk@0.12.0

## 0.2.5

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.4

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.3

### Patch Changes

- d3ed5a5: Annotate multi-line authoring fields with `x-telo-widget: code` so the telo editor renders a Monaco editor instead of a single-line text input. `Ai.Text.system` and `Ai.TextStream.system` get `text/markdown`; `Sql.Query.inputs.sql`, `Sql.Exec.inputs.sql`, and `Sql.Migration.sql` get `application/sql`; `Starlark.Script.code` gets the widget without a `contentMediaType` (Monaco has no Starlark language, so it falls back to plaintext rather than mis-highlighting as Python).

## 0.2.2

### Patch Changes

- Updated dependencies [b62e535]
  - @telorun/sdk@0.7.0

## 0.2.1

### Patch Changes

- Updated dependencies [dccd3a6]
- Updated dependencies [2e0ad31]
  - @telorun/sdk@0.6.0

## 0.2.0

### Minor Changes

- fc4a562: Add a native Rust controller for `std/starlark`, opt-in via `runtime: rust` on a `Telo.Import`. Implementation lives at `modules/starlark/rust/` and is loaded by the kernel's `NapiControllerLoader` (delivered in the prior PR). The existing `nodejs` controller stays the kernel-native default — no change for manifests that don't set `runtime:`.

  The Rust controller is currently a PoC scaffold using the new `telorun-sdk` Rust crate (in-tree, not yet published to crates.io): `#[controller]` is the only macro the author touches, and the controller crate is a textbook Rust project with no `use napi` or `#[napi]` in its source. Replacing the scaffold's invoke body with a real `starlark-rust` evaluation is the natural next step — the SDK and macro shape are final.

  Schema and orchestration layers are untouched; this is purely a new implementation behind an existing definition.

### Patch Changes

- Updated dependencies [f76dd0f]
- Updated dependencies [fc4a562]
  - @telorun/sdk@0.5.0

## 0.1.11

### Patch Changes

- Updated dependencies [3c4ac58]
  - @telorun/sdk@0.3.2

## 0.1.10

### Patch Changes

- Updated dependencies [353d7e5]
  - @telorun/sdk@0.3.0

## 0.1.9

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.8

## 0.1.8

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.7

## 0.1.5

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.6

## 0.1.4

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.5

## 0.1.3

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.4

## 0.1.2

### Patch Changes

- Updated dependencies
  - @telorun/sdk@0.2.3

## 0.1.1

### Patch Changes

- Automated release.
- Updated dependencies
  - @telorun/sdk@0.2.2
