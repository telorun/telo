# @telorun/image

## 0.3.0

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

## 0.2.1

### Patch Changes

- 8af345f: The `Telo.Definition` schema is now the sole resource-config contract.

  A controller module's exports become the controller instance verbatim, so an
  `export const schema` silently won over the manifest's `schema:`. The analyzer
  never loads controllers, so those overrides were invisible to `telo check` and
  to the editor, could not be pre-compiled by the validator warm (recompiling on
  every boot, and failing to persist on a read-only image), and were free to drift
  from the manifest they shadowed.

  `ControllerInstance.schema` is removed, and the kernel now validates every
  resource against its definition's schema. All 35 controller-exported schemas are
  gone: 26 were `additionalProperties: true` catch-alls that merely _disabled_ the
  manifest's stricter validation, and 9 kept their TypeBox for `Static<typeof …>`
  typing but no longer export it.

  Two manifests had already drifted and are corrected:

  - `S3.Bucket` was missing `accessKeyId` / `secretAccessKey` entirely, though its
    controller required both. They are now declared (and required) in the manifest.
  - `Assert.ModuleContext` was missing `resources` / `variables` / `secrets`.

  Controller authors: declare config in `telo.yaml`, not in code. An
  `export const schema` is now inert.

## 0.2.0

### Minor Changes

- 69220c8: New `std/image` module. `Image.Overlay` draws labelled rectangles onto an
  image (`@napi-rs/canvas`) and returns annotated bytes plus dimensions — the
  visualization half of vision-grounding loops: shapes are drawn as given and
  clipped at the image edges rather than rejected, in the same pixel top-left
  coordinate space `Pdf.Rasterizer` reports; stroke and label styling are
  resource config, the image and shape list per-invocation inputs.
  `Image.Blank` produces a solid-color canvas — a pipeline seed or hermetic
  test fixture — rejecting unrecognized CSS colors instead of letting the
  canvas silently keep its previous fill. Both kinds encode to a configurable
  `format` (png/jpeg/webp, png default) with `quality` for the lossy formats,
  and report the output's `mediaType`.
