---
sidebar_label: Templating Engines
---

# Templating Engines

`@telorun/templating` is the shared core that powers expression evaluation and
per-property templating across Telo's host packages — kernel, analyzer, telo
editor, and the VS Code extension. It owns three things:

1. **CEL primitives** — the CEL `Environment` builder, expression compile,
   the hole grammar, and the chain validator used by static analysis.
2. **A pluggable engine registry** — every templating engine that participates
   in YAML tag dispatch (`!cel`, `!interpolate`, `!sql`, `!literal`, `!ref`,
   `!include-text`, `!include-bytes`, `!module-path`) is defined here.
3. **The YAML `customTags` factory** — a single source of truth that every
   `parseAllDocuments` call site uses, so the parse-side configuration cannot
   drift between hosts.

## Tag-based templating

A plain string scalar is text, never an expression. Anything dynamic is written
behind a tag:

```yaml
port:     !cel         'ports.http'
greeting: !interpolate 'Hello ${{ variables.name }}!'
header:   !literal     '${{ this is not interpolated }}'
```

| Tag | Semantics |
| --- | --- |
| `!cel` | The entire scalar is one CEL expression, yielding a value of any type. |
| `!interpolate` | Literal text with `${{ }}` holes, always a string: the CEL join of the text with `string(<hole>)` per hole. |
| `!sql` | SQL text whose `${{ }}` holes are bound as query parameters, never spliced. |
| `!literal` | The scalar is opaque text — no interpolation, no analysis. |

`!literal` carries text that is literally `${{ }}` — JSON Schema `const`
values, pattern strings, code samples. A plain string holding `${{` is the
deprecated untagged spelling: loading rewrites it (a lone hole to `!cel`, other
text to `!interpolate`) and reports `DEPRECATED_UNTAGGED_INTERPOLATION`, and
`telo migrate` writes the same rewrite to the file.

### Holes

`!interpolate` and `!sql` read holes with one grammar. A hole opens at `${{`
and closes at the first `}}` outside a CEL string literal and outside any
braces the expression opened, so a hole may hold a map literal or a string
containing `}`. A literal `${{` is written as a hole yielding it:
`${{ '${{' }}`. A hole that never closes is a syntax error.

## Built-in engines

### `cel`

Treats the source as a single CEL expression. Compile produces a
`CompiledValue` that the kernel evaluates against an `EvaluationContext` at
runtime. Static analysis parses, type-checks against the environment typed for
the field, validates member-access chains against the effective context schema,
and flags nullable access.

### `interpolate`

Each hole is compiled and analyzed as its own CEL expression, exactly as under
`!cel`. A hole whose type CEL's `string()` cannot convert is
`INTERPOLATION_HOLE_NOT_CONVERTIBLE`; one that is null, a list or a map at
runtime fails with `ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE`. The engine
declares that it produces a string, so the field's own schema check applies.

### `sql`

Each hole is compiled and analyzed like an `!interpolate` hole, but evaluation
returns the literal fragments and the hole values separately
(`ParameterizedSql`), for the consumer to bind.

### `literal`

Returns the source string verbatim at compile time. Static analysis is a
no-op.

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
   *  literal) return an empty result. */
  analyze(source: string, env: AnalyzeEnv): AnalyzeResult;

  /** The type the tag always produces, when it is a constant of the tag. */
  producedType?(): Record<string, unknown>;

  /** Where the CEL sits inside the scalar — what editors and analysis passes
   *  read instead of recognising the tag. */
  expressionRegions?(source: string): readonly ExpressionRegion[];
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
