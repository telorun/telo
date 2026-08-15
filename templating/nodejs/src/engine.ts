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

/** One module-relative file a tagged node embeds, reported by the engine that
 *  owns the tag.
 *
 *  `path` is relative to the module root — the directory holding `telo.yaml` —
 *  never to the file the tag was written in. That is the rule every other file
 *  reference in a manifest already follows (a controller's `path=` qualifier,
 *  `files:` / `assets:` patterns), and it is what makes a claim survive publish:
 *  publish deletes `include:` and inlines every partial as an extra document
 *  into the single published `telo.yaml`, so the declaring file does not exist
 *  in the artifact and a per-file-relative path would change meaning there.
 *
 *  The path is ALL an engine reports. Which artifact layer the file belongs in
 *  is packaging's vocabulary, from a spec this package otherwise knows nothing
 *  about, and the analyzer already owns that assignment for controller
 *  candidates — so a new layer role stays a change to one package rather than
 *  two. An object rather than a bare string so a future hint (eager/lazy, say)
 *  costs no consumer a signature change. */
export interface EngineFileClaim {
  readonly path: string;
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

  /** Module-relative files this tagged node embeds, if any.
   *
   *  The single seam through which payload membership is discovered: publish
   *  asks the registry what each tag claims rather than recognising tags by
   *  name, so a future tag that embeds files is a one-file change and no
   *  consumer downstream grows a second vocabulary for reading a manifest.
   *  This is the `ref-slot.ts` / `zone-slot.ts` precedent applied to tags.
   *
   *  Optional, and absent on every engine that embeds nothing (`cel`, `ref`,
   *  `literal`, `sql`). Pure string work over the source — it must never read
   *  the filesystem, because the analyzer that calls it runs in the browser.
   *  A source the engine considers malformed claims nothing; `analyze` is what
   *  reports why. */
  fileClaims?(source: string): readonly EngineFileClaim[];

  /** The type this tag ALWAYS produces, as a JSON Schema fragment.
   *
   *  Declared by the engine, never recognised by a consumer — the `fileClaims`
   *  precedent applied to the one fact it left behind. Before this, the analyzer
   *  hardcoded two tag names to hand an `!include-bytes` a byte placeholder and
   *  an `!include-text` a string one; the only place a tag's produced type was
   *  written down was in its consumer, so a future tag producing bytes had to be
   *  added to a set rather than declaring it.
   *
   *  Absent for an engine whose produced type is a function of the SLOT rather
   *  than of the tag — `!cel`, whose type is only derivable from the expression,
   *  and `!ref`, which is an identity marker. Their values keep taking a
   *  slot-shaped placeholder.
   *
   *  What falls out is the property this preserves exactly: because an embed's
   *  type is a constant of the tag, a byte embed at a string slot and text at a
   *  byte slot both fail statically, through the ordinary schema check and with
   *  no diagnostic code of their own. */
  producedType?(): Record<string, unknown>;
}
