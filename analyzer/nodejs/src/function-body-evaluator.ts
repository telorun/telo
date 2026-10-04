/**
 * **The analyzer's own table of module functions** — what a rule condition's
 * module calls dispatch through when `telo check` runs the rule.
 *
 * A rule is evaluated by the analyzer, where no kernel binds anything, so it
 * dispatches through the engine's own per-evaluation namespace seam, from a
 * table of BODY evaluators instead of instances. A function written in CEL is evaluated whatever its determinism —
 * as the catalog's `now()` is — while one reaching a host-backed leaf fails when
 * called, as the catalog's host-backed stubs do. Both are refused where the
 * condition is written (`conditionCallRefusals`); the table only decides what
 * evaluating one anyway does.
 *
 * A body is evaluated as the kernel evaluates it: its arguments bound through the
 * one argument binding both halves share, its parameters and the functions its
 * own module can call in scope, and nothing else.
 *
 * Browser-safe: no Node built-ins.
 */
import type { ResourceManifest } from "@telorun/sdk";
import { buildCelEnvironment, type ModuleCallDispatch } from "@telorun/templating";
import { callArgumentBinding, type ShapeResolver } from "./callable-binding.js";
import { moduleNamesEnvironment, namespaceDispatchOf } from "./cel-environment.js";
import { renderChain, type CallableFlagsIndex } from "./callable-flags.js";
import { moduleCallNamesOf } from "./module-call-names.js";
import type { ModuleFunctionIndex } from "./module-function-index.js";

/** A body, evaluated against its parameters and the table its own module's
 *  calls dispatch through. The table is an ARGUMENT rather than an activation
 *  entry: a namespaced call is dispatched through the engine's own per-
 *  evaluation seam, which no name in the activation can reach. */
type Evaluate = (
  activation: Record<string, unknown>,
  dispatch: ModuleCallDispatch,
) => unknown;
type ModuleFunction = (args: readonly unknown[]) => unknown;

let evaluationEnv: ReturnType<typeof buildCelEnvironment> | undefined;

/** A dispatch table resolving each qualified name on first use, for one calling
 *  module. A real map: the CEL engine reads it as one. */
class ResolvingDispatch extends Map<string, ModuleFunction> {
  constructor(private readonly resolveEntry: (qualified: string) => ModuleFunction | undefined) {
    super();
  }

  override get(qualified: string): ModuleFunction | undefined {
    if (!super.has(qualified)) {
      const entry = this.resolveEntry(qualified);
      if (!entry) return undefined;
      super.set(qualified, entry);
    }
    return super.get(qualified);
  }

  override has(qualified: string): boolean {
    return this.get(qualified) !== undefined;
  }
}

export class FunctionBodyEvaluators {
  private readonly tables = new Map<ResourceManifest, ModuleCallDispatch>();
  private readonly bodies = new Map<ResourceManifest, Evaluate | null>();

  constructor(
    private readonly functions: ModuleFunctionIndex,
    private readonly flags: CallableFlagsIndex,
    private readonly moduleCallNames: ReadonlyMap<string, ReadonlySet<string>>,
    private readonly resolveRef: ShapeResolver,
  ) {}

  /** The functions an expression written in `caller`'s module may call. */
  dispatchFor(caller: ResourceManifest): ModuleCallDispatch {
    let table = this.tables.get(caller);
    if (!table) {
      table = new ResolvingDispatch((qualified) => this.entryFor(caller, qualified));
      this.tables.set(caller, table);
    }
    return table;
  }

  private entryFor(caller: ResourceManifest, qualified: string): ModuleFunction | undefined {
    const flags = this.flags.ofCall(caller, qualified);
    if (!flags) return undefined;
    if (flags.hostBacked) {
      // The catalog's own posture for a host-backed function: present, and
      // failing when called, since the analyzer has no host to run it on.
      return () => {
        throw new Error(
          `'${qualified}' needs the runtime's host (${renderChain(flags.hostBackedVia)}) and ` +
            "cannot run at telo check",
        );
      };
    }
    const resolution = this.functions.resolve(caller, qualified);
    if (resolution.status !== "resolved") return undefined;
    const target = resolution.manifest;
    const evaluate = this.bodyOf(target);
    if (!evaluate) return undefined;
    const { params, returns } = this.functions.signatureOf(target);
    const binding = callArgumentBinding(qualified, params, returns, this.resolveRef);
    return (args) => {
      const refused = binding.arityRefusal(args.length);
      if (refused) throw new Error(refused.message);
      return binding.result(evaluate(binding.bind(args), this.dispatchFor(target)));
    };
  }

  private bodyOf(target: ResourceManifest): Evaluate | undefined {
    if (this.bodies.has(target)) return this.bodies.get(target) ?? undefined;
    const body = this.functions.bodyOf(target);
    let evaluate: Evaluate | null = null;
    if (body && body.source === undefined) {
      const literal = body.value;
      evaluate = () => literal;
    } else if (body?.source !== undefined) {
      evaluationEnv ??= buildCelEnvironment();
      const env = moduleNamesEnvironment(
        evaluationEnv,
        moduleCallNamesOf(this.moduleCallNames, target),
      );
      const parsed = env.parse(body.source);
      if (parsed.diagnostics.length > 0) {
        // A body that does not parse is `CEL_SYNTAX_ERROR`'s to report where it
        // is written; a rule calling it fails as a call to nothing runnable.
        evaluate = null;
      } else {
        const program = env.compile(parsed);
        evaluate = (activation, dispatch) =>
          program.evaluate(activation as never, {
            namespaceFunction: namespaceDispatchOf(dispatch),
          });
      }
    }
    this.bodies.set(target, evaluate);
    return evaluate ?? undefined;
  }
}
