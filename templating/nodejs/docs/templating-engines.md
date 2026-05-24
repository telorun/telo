---
sidebar_label: Templating Engines
---

# Templating Engines

`@telorun/templating` is the shared core that powers expression evaluation and
per-property templating across Telo's host packages — kernel, analyzer, telo
editor, and the VS Code extension. It owns three things:

1. **CEL primitives** — the CEL `Environment` builder, the `${{ }}` compile
   path, and the chain validator used by static analysis.
2. **A pluggable engine registry** — every templating engine that participates
   in YAML tag dispatch (today `!cel` and `!literal`) is defined here.
3. **The YAML `customTags` factory** — a single source of truth that every
   `parseAllDocuments` call site uses, so the parse-side configuration cannot
   drift between hosts.

## Tag-based templating

By default, a string scalar in a manifest is interpreted as a CEL template:
any `${{ ... }}` segments are interpolated, anything else is plain text.

```yaml
greeting: "Hello ${{ variables.name }}!"   # untagged — CEL interpolation
```

For per-property control, prefix the value with an explicit YAML tag:

```yaml
greeting: !cel       'variables.name'
header:   !literal   '${{ this is not interpolated }}'
fallback: 'Hello ${{ variables.name }}!'   # untagged
```

| Tag | Semantics |
| --- | --- |
| `!cel` | The entire scalar is one CEL expression. No `${{ }}` wrapping. |
| `!literal` | The scalar is opaque text — no interpolation, no analysis. |
| _untagged_ | `${{ }}` segments interpolated; everything else literal. |

`!literal` is the escape hatch for fields that need to carry literal `${{ }}`
text — JSON Schema `const` values, pattern strings, code samples, etc.

## Built-in engines

### `cel`

Treats the source as a single CEL expression. Compile produces a
`CompiledValue` that the kernel evaluates against an `EvaluationContext` at
runtime. Static analysis runs the same chain validator as the untagged
`${{ }}` path: parse → extract member-access chains → validate each chain
against the effective context schema.

The Monaco language id for the editor is `cel`.

### `literal`

Returns the source string verbatim at compile time. Static analysis is a
no-op. Useful any time a value happens to contain `${{ }}` for unrelated
reasons.

## Adding a new engine

The package exports a single source of truth — `builtinEngines` and
`createDefaultRegistry()`. Per-host à-la-carte registration is forbidden:
that path lets a manifest validate clean in one host (e.g. `cel` only) and
crash in another (e.g. `cel + literal`). New engines are added by extending
`builtinEngines` here, then propagating to every host on the next install.

An engine implements:

```ts
interface TemplatingEngine {
  /** Registry key matching the YAML tag name (without `!`). */
  name: string;

  /** Optional Monaco language id for editor syntax highlighting. */
  language?: string;

  /** Convert a tagged source string into a runtime value. Called once at
   *  precompile. Returns either a CompiledValue (engines that defer
   *  evaluation to a runtime EvalContext, like cel) or a plain value
   *  (engines that resolve fully at compile time, like literal). */
  compile(source: string, env: CompileEnv): CompiledValue | unknown;

  /** Static analysis hook. Engines that can't statically check (e.g.
   *  literal) return []. The walker accumulates diagnostics across all
   *  values. */
  analyze(source: string, env: AnalyzeEnv): readonly EngineDiagnostic[];
}
```

## Architecture notes

- **Browser-safe.** The package has no Node built-in dependencies. The
  analyzer (which must run in the browser per Telo's architecture) consumes
  it transitively without polyfills.
- **`CompiledValue` is unchanged.** Engine identity is captured inside the
  `call(ctx)` closure. The kernel's hot path stays a single dispatch through
  `isCompiledValue(v) && v.call(ctx)`; it does not learn about engines.
- **One registry, one parse config.** The `defaultCustomTags()` helper
  memoizes the `customTags` array built from the default registry. Every
  `parseAllDocuments` call site imports it.
