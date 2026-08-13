import type { Environment } from "@marcbachmann/cel-js";
import type { CompiledValue } from "@telorun/sdk";

/** Compile-time environment passed to `engine.compile`. Engines that need to
 *  parse against a CEL environment (the `cel` engine) read it from `celEnv`;
 *  engines that resolve fully at compile time (`literal`) ignore it. */
export interface CompileEnv {
  readonly celEnv: Environment;
}

/** Analyze-time environment passed to `engine.analyze`. The walker resolves
 *  the path-specific effective context (kernel globals merged in, x-telo-context
 *  applied) and hands the engine a single closed schema. The engine validates
 *  member-access chains against it. `null` means "open context" — no chain
 *  validation possible.
 *
 *  `celEnv` is the environment **typed for this path**, not the bare base one:
 *  the engine type-checks against it, so the caller must not check the same
 *  expression again against a different environment. One expression, one
 *  verdict. */
export interface AnalyzeEnv {
  readonly celEnv: Environment;
  readonly contextSchema: Record<string, unknown> | null;
}

/** A mechanically applicable repair for a diagnostic. `replacement` is the
 *  **whole analyzed source**, corrected — never a fragment — so a consumer can
 *  apply it by replacing the scalar node without knowing anything about the
 *  language inside it.
 *
 *  There is deliberately no sub-range narrowing "what changed". Carrying one
 *  beside a whole-value replacement offers two readings of the same field, and
 *  the minimal-edit reading — splice `replacement` at `range` — produces
 *  garbage, since the two measure different strings. No consumer needed it, so
 *  the ambiguity bought nothing.
 *
 *  Producers emit a fix only when the repair is decidable. A fix that might not
 *  compile is worse than none: the field exists so an IDE can apply it without
 *  asking, and an agent can take it without re-deriving it from prose. */
export interface DiagnosticFix {
  readonly replacement: string;
}

/** A single static-analysis finding produced by an engine. Stable codes match
 *  the analyzer's existing diagnostic codes so downstream filtering keeps
 *  working unchanged across the engine boundary. */
export interface EngineDiagnostic {
  readonly message: string;
  readonly code?: string;
  readonly fix?: DiagnosticFix;
}

/** One function call an engine found in the source it analyzed. Reported
 *  regardless of whether the call is valid: consumers apply policy the engine
 *  cannot know (an `x-telo-eval: compile` field rejecting a non-deterministic
 *  call), and policy that depends on manifest context does not belong in a
 *  templating engine. */
export interface CallSite {
  readonly name: string;
  /** How it was written — `f(x)` vs `x.f()`. */
  readonly form: "global" | "receiver";
  /** Argument count as written; excludes the receiver. */
  readonly arity: number;
  /** Offsets of the whole call within the analyzed source. */
  readonly start: number;
  readonly end: number;
  /** Whether the resolved function re-evaluates per call. `undefined` when the
   *  name resolves to nothing, or to a function carrying no determinism
   *  metadata — absent is not "deterministic". */
  readonly deterministic?: boolean;
}

/** What one `analyze` call establishes about one source. Everything derivable
 *  from the expression alone is derived here, once; everything that needs
 *  manifest context (the field's declared type, its eval mode, which verdict
 *  outranks which) is left to the caller, which is the only side that has it. */
export interface AnalyzeResult {
  readonly diagnostics: readonly EngineDiagnostic[];
  /** Type the engine's checker resolved, when it type-checks and succeeded. */
  readonly type?: string;
  /** Every function call in the source, in source order. */
  readonly calls: readonly CallSite[];
}

/** Per-property templating engine. Matches a YAML tag (`!<name>`); the kernel
 *  and analyzer dispatch through the registry rather than knowing about
 *  specific engines. */
export interface TemplatingEngine {
  /** Registry key matching the YAML tag name (without `!`). */
  readonly name: string;

  /** Optional Monaco language id for editor syntax highlighting. Currently
   *  unread — the editor's CelFieldWrapper uses a plain `<input>`. Wiring
   *  this through to a Monaco editor instance is tracked separately; the
   *  field is documented intent so engine authors don't have to revisit
   *  the interface when Monaco lands.
   *  TODO(editor): consume `engine.language` from the field renderer. */
  readonly language?: string;

  /** Convert a tagged source string into a runtime value. Called once at
   *  precompile. Returns either a CompiledValue (engines that defer evaluation
   *  to a runtime EvalContext, like `cel`) or a plain value (engines like
   *  `literal` that resolve fully at compile time). */
  compile(source: string, env: CompileEnv): CompiledValue | unknown;

  /** Static analysis hook. Engines that can't statically check (e.g. `literal`)
   *  return an empty result. The walker accumulates diagnostics across all
   *  values and applies its own policy to `calls` / `type`. */
  analyze(source: string, env: AnalyzeEnv): AnalyzeResult;
}
