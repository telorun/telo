# Per-property templating engines via YAML tags

## Goal

Allow manifest authors to pick the templating engine for a value by writing an explicit YAML tag:

```yaml
greeting: !cel       'variables.name'
header:   !literal   '${{ this is not interpolated }}'
fallback: 'Hello ${{ variables.name }}!'   # untagged → existing behavior
```

A registry maps tag names to engines. The kernel and analyzer dispatch through the registry so neither knows about specific engines.

## Non-goals (this iteration)

- Handlebars or any other engine — only `cel` and `literal` ship. Registry stays plug-ready.
- Replacing the existing `${{ }}` CEL pipeline. CEL is wrapped, not rewritten.
- Changing `CompiledValue`. Engine identity stays encapsulated inside its closure.

## Design

### 1. `TemplatingEngine` interface

```ts
interface TemplatingEngine {
  /** Registry key matching the YAML tag name (without `!`). */
  name: string;

  /** Optional Monaco language id for editor syntax highlighting. */
  language?: string;

  /**
   * Convert a tagged string into a runtime value. Called once at precompile.
   * Returns either a CompiledValue (for engines that need an EvalContext at
   * runtime) or a plain value (for engines like `literal` that resolve fully
   * at compile time).
   */
  compile(source: string, env: CompileEnv): CompiledValue | unknown;

  /**
   * Static analysis hook. REQUIRED. Engines that can't statically check
   * return []. Forces every engine to make a conscious choice rather than
   * silently skipping validation.
   */
  analyze(source: string, env: AnalyzeEnv): Diagnostic[];
}
```

`CompiledValue` ([sdk/nodejs/src/compiled-value.ts:4](../../sdk/nodejs/src/compiled-value.ts#L4)) is **unchanged**. Engine info is captured inside the `call(ctx)` closure. The kernel keeps its single dispatch path:

```ts
if (isCompiledValue(v)) v.call(ctx)
```

Static analysis stays separate — see §7.

### 2. Registry

```ts
class TemplatingEngineRegistry {
  register(engine: TemplatingEngine): void;
  get(name: string): TemplatingEngine | undefined;
  has(name: string): boolean;
}
```

The registry only handles **tagged** values. Untagged `${{ }}` on `x-telo-eval` fields never touches it — it stays on the existing precompile path, unchanged. So there's no "default engine" concept.

The interface, registry, and built-in engines all live in a new package at `templating/nodejs/` (published as `@telorun/templating`). Consumers depend on it: `kernel`, `analyzer`, `apps/telo-editor`, `ide/vscode`.

**Single source of truth for which engines are registered.** The package exports a `builtinEngines` array and a `createDefaultRegistry()` factory; every host calls the same factory. Per-host à-la-carte registration is forbidden — that path leads to a manifest validating clean in the analyzer (cel only) and crashing at runtime in the kernel (cel+literal), or vice versa. New engines are added by extending `builtinEngines` in the shared package, propagating to every host on the next install.

**Browser constraint.** The analyzer must run in the browser without Node polyfills (per CLAUDE.md). `@telorun/templating` becomes a transitive dep of the analyzer, so it must be browser-safe too: no `fs`/`path`/`url`/`child_process`/etc. The CEL engine registers `Stream` from `@telorun/sdk` the same way `cel-environment.ts` does today; this stays in the engine's `compile`/`analyze` builders, which run in both Node and browser. Any Node-specific adapter (file readers, process env access) belongs in the consuming host package, never inside `@telorun/templating`.

### 3. CEL engine — shared core, no duplication

The CEL compile + chain-validator logic is **extracted into the new `@telorun/templating` package** as a shared core, and **both** consumers — the existing implicit `${{ }}` path and the new `!cel` tag engine — call into it. No fork. Future changes (new CEL functions, new `x-telo-*` rules, new stream semantics) land in one place and apply uniformly.

**Extraction plan (no behavior change):**

1. Move the CEL compile body from [analyzer/nodejs/src/precompile.ts:29-57](../src/precompile.ts#L29-L57) into `@telorun/templating/src/cel/compile.ts`. Keep its public signature.
2. Move the chain-validator helpers from [analyzer/nodejs/src/validate-cel-context.ts:49-182](../src/validate-cel-context.ts#L49-L182) (`extractAccessChains`, `validateChainAgainstSchema`) into `@telorun/templating/src/cel/analyze.ts`.
3. Move `walkCelExpressions` from [analyzer/nodejs/src/analyzer.ts:72](../src/analyzer.ts#L72) into the same module — it's the actual chain-dispatch loop that drives the helpers above and `§7`'s tagged-field branch needs to extend it. Without moving it, we'd duplicate the walker.
4. Move `buildCelEnvironment` from [analyzer/nodejs/src/cel-environment.ts:33](../src/cel-environment.ts#L33) into `@telorun/templating/src/cel/environment.ts`. The CEL engine owns the environment builder; analyzer (`analyzer.ts:418`) and `manifest-loader.ts:50` re-import from `@telorun/templating`. This keeps `Stream` registration and CEL function registration in one place and is consistent with the browser-safety constraint stated in §2 (the new package stays Node-built-in-free).
5. The existing `precompile.ts`, `validate-cel-context.ts`, and the relevant entrypoints in `analyzer.ts` become thin call-throughs to the shared core. The full test suite must pass byte-for-byte before going further.

**CEL engine** (in `@telorun/templating/src/engines/cel.ts`):

- `compile(source, env)` — calls the shared core, but treats `source` as a single CEL expression (no `${{ }}` scanning).
- `analyze(source, env)` — calls the shared chain-validator core.
- `language: "cel"`

**Semantics:** under `!cel`, the entire tagged scalar is treated as a single CEL expression. No `${{ }}` wrapping — that's the implicit-path syntax. So `!cel 'variables.port + 1'` parses the whole string as one expression. Authors who want literal text mixed with expressions stay on the untagged `${{ }}` path.

The two paths converge on the same compile/analyze functions; the only difference is whether the input is a full expression (tagged) or `${{ }}`-delimited segments inside a string (untagged).

### 4. Literal engine

- `compile(source, env)` returns `source` unchanged (plain string, no CompiledValue wrapper).
- `analyze` returns `[]`.
- `language` undefined.

### 5. YAML tag wiring

There are **five** call sites that hand text to `parseAllDocuments`. All must use the same `customTags` config or tags get silently dropped to `null` in some code paths.

- [analyzer/nodejs/src/manifest-loader.ts:77](../src/manifest-loader.ts#L77) — main module load
- [analyzer/nodejs/src/manifest-loader.ts:197](../src/manifest-loader.ts#L197) — `loadPartialFile`, the path used to load `include`d partials. The kernel reaches both of these via the analyzer's `Loader` ([kernel/nodejs/src/kernel.ts:251](../../../kernel/nodejs/src/kernel.ts#L251)), so wiring the analyzer covers the kernel.
- [apps/telo-editor/src/yaml-document.ts:11](../../../apps/telo-editor/src/yaml-document.ts#L11) — editor parse
- [cli/nodejs/src/commands/publish.ts:106](../../../cli/nodejs/src/commands/publish.ts#L106) — `publish` expanding includes
- [cli/nodejs/src/commands/publish.ts:184](../../../cli/nodejs/src/commands/publish.ts#L184) — `publish` canonicalizing import refs

To avoid drift, the `customTags` config is built once in the new `@telorun/templating` package (from the registered engines) and exported. Each call site imports the same factory.

Each engine's tag handler implements **both** `resolve` and `stringify` (eemeli/yaml requires both for round-trip):

```ts
{
  tag: '!cel',                                  // or '!literal'
  resolve: (value: string) => ({ __tagged: true, engine: 'cel', source: value }),
  identify: (v: unknown) => isTagged(v, 'cel'), // recognize our sentinel during serialize
  stringify: (item, ctx, ...) =>                // emit the original `source` back
    stringifyTaggedScalar(item, ctx, ...),
}
```

`resolve` converts at parse time; `identify` + `stringify` round-trip back to `!cel "source text"` on serialize. Without `stringify`, `Document.toString()` would serialize the sentinel as a YAML mapping (`{__tagged: true, engine: cel, source: ...}`), corrupting the file on the editor's first save.

The sentinel object survives `doc.toJSON()` so it reaches precompile in the analyzer/kernel path. The set of registered tags is derived from the registry — adding a new engine means registering it; the loader picks up its tag automatically.

### 6. Precompile dispatch

[analyzer/nodejs/src/precompile.ts](../src/precompile.ts) gets one new branch at the per-value site, sitting in front of the existing logic:

1. **New:** sentinel object (tagged value) → registry lookup → `engine.compile(source, env)`.
2. **Existing (now thin):** plain string with `${{ }}` on a `x-telo-eval` field → calls into `@telorun/templating/cel/compile` (the shared core extracted in §3). Behavior identical to today.
3. **Unchanged:** otherwise → pass through.

After §3's extraction, branches 1 and 2 reach the same compile core; the only difference is the input shape (whole string vs. scanned-out `${{ }}` segments).

### 7. Analyzer integration

**No side table.** Engine identity travels with the value. Position info already lives in `metadata.positionIndex` ([analyzer/nodejs/src/manifest-loader.ts:87-115](../src/manifest-loader.ts#L87-L115)) and the existing diagnostic walk (`walkCelExpressions` at [analyzer.ts:72](../src/analyzer.ts#L72), to be relocated per §3) uses dot-notation paths, not RFC 6901 — duplicating the location key in a side table would force two pointer schemes to stay in sync at every query.

Instead, the sentinel object stays in the manifest tree alongside the compiled function. The compiled value produced by precompile for a tagged field is shaped like:

```ts
{ __tagged: true, __compiled: true, engine: 'cel', source: '...', call(ctx) }
```

- **Kernel** sees `__compiled: true` and calls `.call(ctx)`. Doesn't read `engine` or `source`. The `CompiledValue` runtime contract is unchanged.
- **Analyzer** sees `__tagged: true` and reads `engine` + `source` for diagnostics.

The two consumers look at different facets of the same object — engine info is encapsulated in the sense that the kernel's hot path ignores it, but the analyzer can still see it without a parallel index.

`walkCelExpressions` is taught one new case: when it encounters a sentinel where it expects a `${{ }}`-bearing string, it dispatches to `engine.analyze(source, env)` (which calls the shared chain-validator core for `cel`, returns `[]` for `literal`). Untagged `${{ }}` strings call the same shared core directly. Both paths flow through the same diagnostic walk; the dot-notation paths it already produces work for tagged and untagged fields uniformly.

### 8. Editor integration

Two pieces:

**Detection / rendering.** Today, two helpers in [apps/telo-editor/src/components/resource-schema-form/cel-utils.ts](../../../apps/telo-editor/src/components/resource-schema-form/cel-utils.ts) check schema annotation + a regex; they're called by the field renderer (e.g. `cel-field-wrapper.tsx`) to pick CEL UI vs. plain input. Update both helpers and the calling renderer to:

1. Inspect the YAML AST node's `.tag` directly (the editor stores the `Document` AST in [apps/telo-editor/src/yaml-document.ts](../../../apps/telo-editor/src/yaml-document.ts)).
2. Tag → registry → `engine.language` for Monaco mode.

**Edit ops** in `applyEdit` ([apps/telo-editor/src/yaml-document.ts:123-166](../../../apps/telo-editor/src/yaml-document.ts#L123-L166)). The existing opcodes (`set`, `delete`, `insert`, `rename`) only mutate `Scalar.value`, never `.tag`. Tag mutation requires direct AST access (`scalar.tag = '!cel'` before `setIn`) which no current opcode performs. Two changes needed:

- **New opcode `setTag`** (`{ path, engine: string | null }`) — locates the `Scalar` node at `path` and assigns `scalar.tag` (or clears it when `engine` is `null`).
- **`set` opcode preserves tags** — when `set` updates a value whose `Scalar` already has a tag, the new value is written into `Scalar.value` and the existing `Scalar.tag` stays. Authors editing the inner expression don't lose the tag.

UI engine switch in the renderer dispatches `setTag` to apply/change/remove a tag; inner-expression edits dispatch `set`.

VS Code extension ([ide/vscode/src/extension.ts](../../../ide/vscode/src/extension.ts)) flows through the analyzer, so it picks up validation changes automatically.

## Backwards compatibility

- Untagged manifests work unchanged. `${{ }}` on `x-telo-eval` fields still compiles as CEL via the existing path.
- Tags are purely additive.
- `CompiledValue` shape is unchanged → kernel **evaluation logic** is untouched. (Note: the kernel does still consume YAML via the analyzer's `Loader`, so the parse-side wiring in §5 transitively affects it.)
- No new schema annotations.

## Implementation order

Pending design approval:

1. Scaffold `templating/nodejs/` (`@telorun/templating`): `package.json`, `tsconfig.json`, `src/index.ts`. Wire it into `pnpm-workspace.yaml` and add it as a dep of `kernel`, `analyzer`, `apps/telo-editor`, `ide/vscode`.
2. **Extract the CEL shared core into `@telorun/templating`** (per §3): move CEL compile body and chain-validator body into the new package, refactor `precompile.ts` and `validate-cel-context.ts` to be thin delegations. Full test suite must pass byte-for-byte — this step is purely a relocation.
3. Define `TemplatingEngine` interface + `TemplatingEngineRegistry` in the new package.
4. Implement `cel` engine on top of the shared core (whole-string-as-expression input).
5. Implement `literal` engine.
6. Build the shared `customTags` factory in `@telorun/templating` from registered engines (with `resolve`, `identify`, `stringify` per tag). Wire it into all five `parseAllDocuments` call sites listed in §5. Add tests for: parse → sentinel; serialize → original tagged scalar; full round-trip; tagged value inside an `include`d partial; tagged value through `cli publish`'s include-expansion + import-canonicalization paths.
7. Add the tagged-sentinel branch in `precompile.ts` (in front of the existing branches, additive).
8. Extend the relocated `walkCelExpressions` (now in `@telorun/templating`) to recognize a sentinel object where it expects a `${{ }}`-bearing string. Tagged → `engine.analyze(source, env)`; untagged `${{ }}` → existing chain-validator core. Engine identity is read off the sentinel (`__tagged === true`, `engine`, `source`) — no side table.
9. Editor: update `cel-utils.ts` and field renderer to read tags + pick Monaco language from registry. Add `setTag` opcode to `applyEdit` and teach `set` to preserve tags. Tests for tag round-trip across an edit cycle.
10. **Kernel integration tests** under top-level `tests/` (per `CLAUDE.md` test-discovery layout): manifest with `!cel` end-to-end through the kernel; manifest with `!literal` (verify verbatim string reaches the controller); manifest mixing tagged + untagged on the same field type; tagged values inside `include`d partials. All must pass via `pnpm run test`.
11. Module docs in `templating/nodejs/docs/`, wired into `pages/docusaurus.config.ts` + `pages/sidebars.ts`.
12. Changesets for every published package touched.
