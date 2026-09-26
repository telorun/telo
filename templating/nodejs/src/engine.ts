import type { Environment } from "@marcbachmann/cel-js";
import type { CompiledValue } from "@telorun/sdk";
import type { ModuleCallFlags } from "./cel/diagnose.js";
import type { ModuleCallTypeResolver } from "./cel/module-call.js";

/** Compile-time environment passed to `engine.compile`. Engines that need to
 *  parse against a CEL environment (the `cel` engine) read it from `celEnv`;
 *  engines that resolve fully at compile time (`literal`) ignore it. */
export interface CompileEnv {
  readonly celEnv: Environment;
  /**
   * The names a call's receiver may be for the call to resolve as a MODULE
   * call — the declaring module's `imports:` keys, `Self`, its `metadata.name`
   * and `Telo`.
   *
   * An INPUT, not something an engine derives: they are known from the module's
   * own file before any import resolves, and a partial compiles with the names
   * of the module that includes it. Absent means "no module names here", which
   * leaves every call an ordinary catalog call — the reading every caller had
   * before module functions existed.
   */
  readonly moduleNames?: ReadonlySet<string>;
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
  /**
   * The caller vouches that `celEnv` declares EVERY name legal at this site, so
   * a root identifier it does not know is undeclared rather than merely
   * unmodelled.
   *
   * Opt-in because the environment is only that complete when someone built it
   * for a specific site: the base environment declares CEL's own type names and
   * nothing else, so checking roots against it would report `variables` itself
   * as unknown. Absent means the check is skipped, which is what every caller
   * did before it existed.
   */
  readonly rootsDeclared?: boolean;

  /** The declaring module's names — see {@link CompileEnv.moduleNames}. An
   *  analysis that does not supply them reads a module call as an ordinary
   *  method call, so the compile and analyze halves must be given the same set
   *  or they disagree about what the expression says. */
  readonly moduleNames?: ReadonlySet<string>;

  /** The type a module call yields, when the caller can resolve one. Absent
   *  leaves every module call `dyn` — its arguments are still checked where
   *  they are written, and nothing is claimed about its result. */
  readonly moduleCallType?: ModuleCallTypeResolver;

  /** The JSON Schema a module call's RESULT carries, when the caller can resolve
   *  one — what member access on the result (`Billing.total(xs).amont`) is
   *  checked against. Absent leaves such access unchecked. */
  readonly moduleCallResult?: (qualified: string) => Record<string, unknown> | undefined;

  /** The derived flags of the module function a qualified call reaches, carried
   *  onto its {@link CallSite} — boolean wherever the call resolves, so a
   *  consumer reading `deterministic === false` sees every impure one. */
  readonly moduleCallFlags?: ModuleCallFlags;

  /**
   * Whether a bare identifier could denote a MODULE at all.
   *
   * The host's naming rule, which this package does not own: an unknown call
   * receiver is repaired by an `imports:` alias only where the name could be
   * one, and telling the author of `dbb.query(1)` to add an import is advice
   * for a different mistake. Absent leaves the unknown-identifier message
   * unqualified, which is what it says with no host rule to consult.
   */
  readonly couldNameModule?: (name: string) => boolean;

  /**
   * The names this site reads, as a schema — consulted ONLY to explain a
   * rejection `check()` already made. A chain naming a field it does not declare
   * is then reported as `CEL_UNKNOWN_FIELD` with the fields it does, rather than
   * the checker's own wording. Never a verdict of its own: an expression the
   * checker accepts is not re-judged against it. Lazy, since only a failing
   * expression asks.
   */
  readonly explainSchema?: () => Record<string, unknown> | null;
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
  /** The name called. For a module call this is the QUALIFIED name as written
   *  (`Billing.format`), which is what keeps a module function and a catalog
   *  function of the same bare name apart in every consumer that keys on it. */
  readonly name: string;
  /** How it was written — `f(x)` vs `x.f()`. */
  readonly form: "global" | "receiver";
  /** Set when the receiver is one of the declaring module's names, so the call
   *  resolved to a module function rather than to the catalog. Its determinism
   *  and host-backedness are not this engine's to know — they follow from the
   *  callable the name resolves to — so they are carried only as the host's
   *  {@link AnalyzeEnv.moduleCallFlags} reports them. */
  readonly moduleCall?: true;
  /** Argument count as written; excludes the receiver. */
  readonly arity: number;
  /** For a module call, each argument as the analysis saw it: the type the
   *  checker gave it (absent when the expression did not type-check) and, when
   *  the argument is a plain member chain (`variables.price`), that chain — so a
   *  caller holding the callee's signature can compare a declared shape rather
   *  than a CEL type alone. */
  readonly arguments?: readonly CallArgument[];
  /** Offsets of the whole call within the analyzed source. */
  readonly start: number;
  readonly end: number;
  /** Whether the resolved function re-evaluates per call. `undefined` when the
   *  name resolves to nothing, or to a function carrying no determinism
   *  metadata — absent is not "deterministic". */
  readonly deterministic?: boolean;
  /** Whether the resolved function is supplied by the host rather than written
   *  in CEL — a catalog function the kernel implements natively, or a module
   *  function reaching native code — so nothing without that host can run it.
   *  `undefined` under the same rule as {@link CallSite.deterministic}. */
  readonly hostBacked?: boolean;
}

/** One argument of a module call. */
export interface CallArgument {
  readonly type?: string;
  readonly chain?: readonly string[];
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
  /** The string the whole expression is a literal of, read off the parsed tree
   *  (so `(':memory:')` is one), when it is one. */
  readonly stringLiteral?: string;
  /** When the checker rejected the expression, the CEL type of each plain chain
   *  it reads (`variables.db` → `Telo.HostPath`), so a host can say how to use a
   *  value whose type is what the rejection turned on. */
  readonly readTypes?: readonly string[];
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
  /** The path may name a directory, which then claims every file beneath it.
   *  Whether it does is a question for whoever holds the directory. */
  readonly directory?: boolean;
}

/** One CEL expression inside a tagged scalar, by offset into the scalar's
 *  source. */
export interface ExpressionRegion {
  readonly start: number;
  readonly end: number;
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

  /** Where the CEL expressions sit inside the tagged scalar — the whole source
   *  for `!cel`, each hole's expression for a tag with holes.
   *
   *  What an editor colours, completes, hovers and renames against, so it finds
   *  the expressions of any tag without recognising the tag. Absent on an
   *  engine whose scalar holds no CEL. A source the engine cannot read yields
   *  no regions; `analyze` is what reports why. */
  expressionRegions?(source: string): readonly ExpressionRegion[];
}
