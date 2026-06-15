# @telorun/templating

## 0.10.0

### Minor Changes

- 0c16f41: Move the CEL regex functions onto the RE2 contract. `regexReplace`,
  `regexExtract`, `regexExtractAll`, and `regexGroups` are now backed by
  [`re2js`](https://github.com/le0pard/re2js) — a pure-JS port of Google's RE2 —
  instead of JS `RegExp`. Because it's pure JS (no native addon), regex behaves
  identically under Node, Bun, and the browser, with RE2 semantics: linear-time,
  no backtracking (ReDoS-safe), inline `(?s)` and `$1` replacement backrefs, and
  the `i` / `m` / `s` flags. The three extract functions gain an optional trailing
  `flags` argument.

## 0.9.0

### Minor Changes

- aaa760d: Add eight pure (browser-safe, non-host) CEL standard-library functions to the single-source catalog, so both the runtime and the analyzer pick them up automatically:

  - **Indexing** — `range(int): list<int>` (the one previously-missing primitive: materializes indices for an unknown-length list, e.g. `range(size(xs)).map(i, …xs[i]…)`) and `enumerate(list): list` (pairs each element with its zero-based position as `{index, value}`).
  - **Regex** — `regexReplace(s, pattern, replacement, flags?)` (replaces every match by default, `$1` backrefs), `regexExtract`, `regexExtractAll`, and `regexGroups`.
  - **Affixes** — `trimPrefix` / `trimSuffix` strip a fixed affix when present.

## 0.8.0

### Minor Changes

- ee8926f: Unify resource references on the `!ref` YAML tag. The object form `{ kind, name }`
  and bare-string references are removed: the analyzer rejects them up front
  (`INVALID_REFERENCE_FORM`) and `!ref <name>` / `!ref <Alias>.<name>` is the only
  authored shape. `resolveRefSentinels` now resolves `!ref` sentinels across the
  whole manifest tree (including step `invoke`s and refs nested in inline
  definitions), so every consumer sees the uniform resolved shape. The
  http-server mount slot is renamed `mounts[].type` → `mounts[].mount`, and the
  mcp transports / clients read their Phase-5-injected ref instances directly.

  Schema validation (analyzer and kernel) now drops the stale scalar `type` a ref
  slot may still pin (older published modules encode references as `type: string`)
  before running AJV, so a resolved reference object validates against a legacy
  `x-telo-ref` slot. This keeps an app that consumes a not-yet-republished
  dependency analyzable and bootable during the migration. Object-typed ref slots
  that also accept an inline value (e.g. `inputType` / `outputType`) are left
  untouched.

  `Run.Sequence` reference slots are brought onto the same enforcement path: a
  step `invoke` and a scope `targets` entry now require a `!ref` (the `targets`
  slot gains an `x-telo-ref` constraint and the `with` scope's visibility extends
  to `/targets`), so a bare-string ref at either is rejected with
  `INVALID_REFERENCE_FORM` at `telo check` — uniform with `Telo.Application`
  targets — instead of failing as an obscure runtime error. The controller reads
  the resolved reference rather than a bare name.

## 0.7.0

### Minor Changes

- 2292a84: Upgraded cel-js package to 7.6.1

## 0.6.0

### Minor Changes

- 06cfcbf: Expand the CEL stdlib:

  - **Time:** `nowIso(tz?)` (ISO-8601, UTC by default or in an IANA timezone), `today(tz?)` (`YYYY-MM-DD` in that zone), `nowMillis()` / `nowSeconds()` (absolute epoch int).
  - **UUID:** `uuidv1/3/4/5/6/7()`, `uuidValidate(s)`, `uuidVersion(s)`.
  - **Strings:** `lower`, `upper`, `trim`, `replace(s, old, new)`, `split(s, sep)`.
  - **Math:** `abs`, `floor`, `ceil`, `round`, `min(list)`, `max(list)`.
  - **Collections:** `distinct`, `sort`, `reverse`, `flatten`.
  - **JSON / encoding:** `parseJson(s)`, `base64Encode/Decode`, `urlEncode/Decode`.
  - **Hashing:** `md5`, `sha1`, `sha512`, `hmac(algorithm, key, message)` (host-injected alongside `sha256`).
  - **Null handling:** `default(value, fallback)`, `coalesce(list)` — CEL has no `??`.

  Time/UUID/`nowMillis` are non-deterministic: in an `x-telo-eval: compile` field they bake once at load; use a runtime field for a fresh value per evaluation. Hashing and base64 are host-injected to keep `@telorun/templating` browser-safe (the kernel supplies Node `crypto`/`Buffer`); `buildCelEnvironment` now accepts a partial handler map. Adds `uuid` as a dependency.

- 06cfcbf: Add `telo cel functions` (list the CEL standard library — `--json` for tooling) and `telo cel eval "<expr>" [--context <json>]` (evaluate a CEL expression with the real Node handlers). Backed by a single-source CEL catalog: `@telorun/templating` now exports `celFunctionCatalog()` / `CEL_FUNCTIONS`, and `buildCelEnvironment` registers from it so the documented surface can't drift from what's registered. `@telorun/kernel` exports `nodeCelHandlers` (the Node `crypto`/`Buffer` implementations) so the CLI's eval matches a real run.

## 0.5.0

### Minor Changes

- 64debb5: Add the `!sql` templating engine for safe, dialect-neutral SQL interpolation. A `!sql "… ${{ expr }} …"` scalar evaluates to a parameterized value — literal fragments plus the separately-evaluated value of each interpolation — instead of a joined string, so consumers can emit driver-native placeholders and bind the values rather than splicing them into the SQL text.

  Supporting additions: `@telorun/sdk` gains an optional `parts` field on `CompiledValue` (an interpolated template's segments before they are joined) plus the shared `ParameterizedSql` type and `isParameterizedSql` guard (the marker contract producers and consumers single-source). `@telorun/templating` adds `toParameterized(value, ctx)`, which splits a value into `{ fragments, values }` and backs the new engine.

## 0.4.1

### Patch Changes

- adc248b: Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

  The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.

## 0.4.0

### Minor Changes

- 222b3d6: `Run.Sequence` now guarantees a non-empty `error.code` and `error.message` inside
  every `catch` block. A caught failure that is not a structured `InvokeError`
  (e.g. a plain `Error` thrown by an invoked resource) is surfaced as
  `error.code === "INTERNAL_ERROR"` instead of `null`. A `throw: { code: "${{
error.code }}" }` rethrow can therefore never resolve to `null` — previously such
  a rethrow failed at runtime with `INVALID_THROW_STEP`, masking the underlying
  error.

  The analyzer's throws resolver mirrors this: a `try` block containing an
  `invoke:` step folds `INTERNAL_ERROR` into the union a `catch` re-raises via
  `error.code`, so an HTTP route's `catches:` list must cover it (or include a
  catch-all). The resolver also now recognises the `!cel`-tagged code form in
  `throw:` steps and passthrough call sites, matching the existing `${{ … }}`
  string handling.

  The analyzer now type-checks the `error` object inside `catch:` / `finally:`
  blocks via a new `x-telo-error-context` schema annotation. CEL expressions like
  `${{ error.cdoe }}` (a typo) are flagged with `CEL_UNKNOWN_FIELD` at any nesting
  depth; valid fields (`code` / `message` / `step` / `data`) pass. Inside `finally`
  `error` is typed as nullable (it is `null` on the success path), faithful to the
  runtime contract. The annotation is generic — any composer that declares
  error-bearing branch fields opts in the same way, with no resource kind hardcoded
  in the analyzer.

  CEL chain validation now also enforces null-safety: dereferencing a value whose
  schema admits `null` (e.g. `error` inside `finally`) without a null-guard is a
  static error (`CEL_NULLABLE_ACCESS`). Guards are recognised through `?:`
  ternaries and `&&` / `||` short-circuits (`error != null && error.code`,
  `error == null ? … : error.code`). This is general — it applies to any nullable
  value in any CEL context, not just `Run.Sequence`.

### Patch Changes

- Updated dependencies [ae0bf77]
  - @telorun/sdk@0.13.0

## 0.3.1

### Patch Changes

- bfe4967: Add a `ports` declaration to `Telo.Application`. `ports` is a name-keyed map
  (sibling of `variables` / `secrets`) where each entry binds a host env var to
  an inbound port the app listens on: `{ env, protocol?, default? }`, implicitly
  typed as an integer in the 1–65535 range. Values resolve at `kernel.load()` —
  mirroring the variables env-resolution path, with the same
  `ERR_MANIFEST_VALIDATION_FAILED` aggregation — and surface in a new
  `ports.<name>` CEL scope, so a binding resource reads `${{ ports.http }}` from
  a single declared source. A runner or the editor can read the exposed ports
  (and the env var that configures each) before the app starts. Application-only;
  `Telo.Library` does not declare ports.

  Also adds `x-telo-type`, a general analyzer-only value-brand annotation. A
  port's transport brands its value (`tcp → TcpPort`, `udp → UdpPort`) as a
  nominal CEL type, and a resource field can declare which brand it accepts
  (`http-server`'s `port` is branded `TcpPort`). Wiring a `UdpPort` into a
  `TcpPort`-branded field is a static analyzer error. Brands are analyzer-only —
  the value flows as a plain integer at runtime, so there is no runtime cost.

  Adds an `UNUSED_DECLARATION` warning: a declared `variables` / `secrets` /
  `ports` entry that no CEL expression references is flagged (a generic,
  table-driven pass across the three namespaces). Application-only — a
  `Telo.Library`'s `variables` / `secrets` are a controller-consumed public
  contract and are not flagged.

## 0.3.0

### Minor Changes

- 7889023: Add `!ref <name>` YAML tag for resource references (additive foundation).

  - **templating**: Register a new `ref` engine alongside `cel` and `literal` so `!ref <name>` parses to a `TaggedSentinel` with `engine: "ref"` and the bare resource name as `source`. Adds `isRefSentinel(v)` to detect ref-tag sentinels. Adds a shared `ResourceRefSchema` fragment plus `MANIFEST_SCHEMA_URI` (`telo://manifest`) and `ManifestRootSchema` — the canonical JSON-Schema home for ref-shape definitions that module YAMLs can `$ref` into. The symbols intentionally omit a host-specific prefix since they live in the templating package (the only layer both analyzer and kernel depend on); the URI is the contract.
  - **analyzer**: Recognises `!ref` sentinels at every `x-telo-ref` slot. A new `resolveRefSentinels` pass runs after inline normalization and substitutes each sentinel in-place with `{kind, name}` so downstream phases (reference validation, dependency graph, kernel controllers) see a uniform shape regardless of which surface the user picked. The substitution descends the manifest tree directly and mutates the parent container — no concrete-path string round-trip — so a future change to the field-path encoding can't silently break the writer. `validate-references` emits `UNRESOLVED_REFERENCE` when a sentinel doesn't resolve locally; `dependency-graph` adds boot-order edges for sentinel-named targets. `precompile` leaves ref sentinels intact (they are identity markers, not templating values, and must reach the resolution pass before being collapsed). A new `system-kinds.ts` consolidates the kind-skip sets the three passes (`REF_VALIDATION_SKIP_KINDS`, `DEPENDENCY_GRAPH_SKIP_KINDS`, `REF_RESOLUTION_SKIP_KINDS`) draw from so the asymmetries are named, not implicit. The analyzer's AJV instance now registers `ManifestRootSchema` under `telo://manifest` so module schemas can `$ref` shared fragments without bundling their own copy. The `Telo.Application.targets[]` schema admits both the legacy string form and the post-resolution `{kind, name}` object form, so `!ref <name>` works at that slot too.
  - **kernel**: `SchemaValidator` registers the same `telo://manifest` root so resource-config validators resolve the shared `$ref`. `ResourceContext.resolveChildren` handles `!ref` sentinels that reach a controller directly — currently a stopgap for slots hidden behind a local `$ref: "#/$defs/..."` that the analyzer's field-map walker doesn't descend; see follow-up below. `Kernel.load()` normalises `Telo.Application.targets[]` entries down to bare resource names whether the source surface was a string or a sentinel-resolved `{kind, name}` object — and now throws `ERR_INVALID_VALUE` on an entry it can't normalize rather than silently dropping it.

  **Follow-up (separate PR):** enable the analyzer's reference-field-map walker to follow local `#/$defs/<name>` refs. The walker already descends `oneOf`/`anyOf`/`allOf` variant properties in this PR; the remaining gap is the early-return on `$ref` (the recursion + cycle-detection plumbing is in place but the descent branch is disabled). Turning it on without first updating `Run.Sequence`'s controller (and any other dispatcher with the same pattern) to route through `EvaluationContext.invokeResolved` regardless of Phase-5 instance injection regresses the kernel's `<Kind>.<Name>.Invoked` event emission — sequence steps call `instance.invoke()` directly when handed a live instance, bypassing the kernel's emit path. The walker fix and the dispatcher fix have to land together; once they do, the `!ref` fallback in `ResourceContext.resolveChildren` becomes dead code and can be removed (preserving the polyglot contract where every controller — Node or otherwise — sees only `{kind, name}` at ref slots).

  The legacy ref shapes (bare-name strings and `{kind, name}` objects) are unchanged and continue to work. This change is non-breaking — no existing manifests, schemas, or controllers need to migrate yet. A subsequent migration sweep will convert every module schema to `$ref: "telo://manifest#/$defs/ResourceRef"` and rewrite example/test manifests to `!ref`, after which the legacy paths can be removed.

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

## 0.2.3

### Patch Changes

- Updated dependencies [58362c4]
  - @telorun/sdk@0.11.1

## 0.2.2

### Patch Changes

- Updated dependencies [f1c35bc]
- Updated dependencies [47f7d83]
  - @telorun/sdk@0.10.0

## 0.2.1

### Patch Changes

- 30bcfef: Catch references to nonexistent step results in Run.Sequence-shaped manifests at static-analysis time.

  Two analyzer gaps let a broken CEL chain like `steps.parseManifest.result.docs[?0].?kind` slip past `telo check` and only fail at runtime with `No such key: parseManifest`:

  - `@telorun/analyzer`: `buildStepContextSchema` registered every named step in the steps map, including control-flow wrappers (`try`, `if`, `while`, `switch`, `throw`) that never produce a result. With a permissive `result: { additionalProperties: true }` placeholder under each wrapper, the chain validator treated every typo or stale reference as valid. Now only steps that carry an `invoke` field register a result-producer entry; wrappers are still descended into via `x-telo-topology-role: branch`, so their inner invokes are unaffected.
  - `@telorun/templating`: `extractAccessChains` only descended into `node.args` when it was an array. cel-js represents unary operators (`!_`, `-_`) with a single `ASTNode` directly in `args`, so any chain inside `!(...)` or `-(...)` was dropped from validation. The walker now also descends when `args` is a single `ASTNode`.

  Both fixes are needed for the typical "negated optional-access chain in a try-wrapped step" pattern (e.g. an `if: "${{ !(steps.<wrapper>.result.docs[?0].?kind ...) }}"` predicate).

## 0.2.0

### Minor Changes

- 88e5cb4: Introduce per-property templating engines via YAML tags. New `@telorun/templating` package owns the shared CEL core (compile, chain validator, walker, environment) and a pluggable engine registry. Two built-in engines ship: `!cel` (single CEL expression — no `${{ }}` wrapping) and `!literal` (opaque text — no interpolation, no analysis). Untagged `${{ }}` strings continue to compile as CEL exactly as before. The kernel, analyzer, telo editor, and VS Code extension now share one source of truth for engine registration and YAML tag parsing.
