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
 *  validation possible. */
export interface AnalyzeEnv {
  readonly celEnv: Environment;
  readonly contextSchema: Record<string, unknown> | null;
}

/** A single static-analysis finding produced by an engine. Stable codes match
 *  the analyzer's existing diagnostic codes so downstream filtering keeps
 *  working unchanged across the engine boundary. */
export interface EngineDiagnostic {
  readonly message: string;
  readonly code?: string;
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
   *  return []. The walker accumulates diagnostics across all values. */
  analyze(source: string, env: AnalyzeEnv): readonly EngineDiagnostic[];
}
