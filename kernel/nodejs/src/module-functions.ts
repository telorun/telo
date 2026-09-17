/**
 * **Module functions at runtime**: the per-scope table a CEL module call
 * dispatches through, and how one call becomes a call on a callable instance.
 *
 * A call written `Billing.format(x)` is resolved to a late-bound call node when
 * the expression is compiled (`@telorun/templating`'s `module-call.ts`), and that
 * node reads a dispatch table from the activation under a key no CEL source can
 * spell. This module is the other half: the table a module context puts there,
 * and the adapter each entry is.
 *
 * **Bound once per scope per name, at `create()`.** The kernel binds every call a
 * resource's manifest makes when the resource is created, before its compile-eval
 * fields expand — so a call in a branch that never runs still fails at boot, and
 * evaluating a call is a table lookup rather than a resolution. Two isolated
 * imports of one library are two module contexts and bind twice; one table per
 * context is also what keeps a second in-process kernel from reaching this one's
 * functions.
 *
 * **Dropped when the provider is withdrawn.** An entry holds the instance it was
 * bound to, so unwinding that instance replaces the entry with one that reports
 * the withdrawal, and the next bind resolves again. Every bound call belongs to a
 * resource that holds a dependency edge on the provider, so those resources are
 * rebuilt with it and bind the replacement.
 *
 * **Not every expression belongs to a created resource.** An Application's
 * `logging:` block is expanded while the application loads, and a type rule's
 * condition is evaluated against the value alone wherever its shape is checked;
 * neither binds anything, so a call there fails. `telo check` refuses both where
 * they are written (`x-telo-unbound-calls`).
 */
import {
  ERR_INVOKE_CANCELLED,
  InvokeError,
  isCompiledValue,
  RuntimeError,
  type ResourceDefinition,
  type ResourceInstance,
  type ResourceManifest,
} from "@telorun/sdk";
import {
  CALLABLE_CAPABILITY,
  callArgumentBinding,
  inheritedCapability,
  isCallableKind,
  resolveSignature,
  type DefResolver,
  type SignatureParam,
} from "@telorun/analyzer";
import type { ModuleCallDispatch } from "@telorun/templating";
import { functionFailure, signatureBoundCallOf } from "./function-binding.js";

/** One dispatch entry: the positional arguments of one call site. */
export type ModuleFunction = (args: readonly unknown[]) => unknown;

/** A qualified call resolved to a callable. */
export interface BoundFunction {
  /** The name, in the binding module, the call depends on: the callee itself for
   *  a call through `Self` or the module's own name, the import for a call
   *  through an alias. Withdrawing that resource drops the binding. */
  readonly holder: string;
  readonly call: ModuleFunction;
}

/** The dispatch table of one module context. */
export class ModuleFunctionTable {
  /** What the CEL engine reads. Mutated in place and never replaced, so every
   *  context that copied the module's CEL context shares it. */
  readonly dispatch: Map<string, ModuleFunction> & ModuleCallDispatch = new Map();
  private readonly holders = new Map<string, string>();

  /** Bind `qualified` unless it is already bound. `resolve` runs only when it is
   *  not, and throws the refusal or the deferral the call earns. */
  bind(qualified: string, resolve: () => BoundFunction): void {
    if (this.holders.has(qualified)) return;
    const bound = resolve();
    this.dispatch.set(qualified, bound.call);
    this.holders.set(qualified, bound.holder);
  }

  /**
   * Drop every binding that depends on `holder`. The entry is not deleted but
   * replaced: an expression still in flight when its provider went away reads a
   * cancellation naming why, rather than an "unbound function" that describes a
   * manifest defect nobody made.
   */
  withdraw(holder: string, reason: string): void {
    for (const [qualified, bound] of this.holders) {
      if (bound !== holder) continue;
      this.holders.delete(qualified);
      this.dispatch.set(qualified, () => {
        throw new InvokeError(
          ERR_INVOKE_CANCELLED,
          `Function '${qualified}' is no longer available: ${reason}.`,
          { function: qualified },
        );
      });
    }
  }
}

const callsByManifest = new WeakMap<object, readonly string[]>();

/**
 * Every qualified module call a manifest makes, deduplicated, in first-seen
 * order.
 *
 * Read off the `calls` each compiled value carries — never a re-parse, which
 * cannot tell `Billing.format(x)` from a method on a variable without the
 * declaring module's name set. Walks plain containers only: after Phase-5
 * injection a slot may hold a live instance, whose object graph is not the
 * manifest's. Memoized per manifest object, since a `with:`-scoped resource is
 * created on every run of its scope.
 */
export function moduleCallsOf(manifest: ResourceManifest): readonly string[] {
  const cached = callsByManifest.get(manifest);
  if (cached) return cached;
  const found = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (isCompiledValue(value)) {
      for (const call of value.calls ?? []) found.add(call);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return;
    for (const child of Object.values(value)) visit(child);
  };
  visit(manifest);
  const calls = [...found];
  callsByManifest.set(manifest, calls);
  return calls;
}

/** The receiver and function name of a qualified call. */
export function splitQualifiedCall(qualified: string): { receiver: string; name: string } {
  const dot = qualified.indexOf(".");
  return { receiver: qualified.slice(0, dot), name: qualified.slice(dot + 1) };
}

/** Resolves a type reference to the schema it names — the kernel's registry. */
export type ShapeLookup = (ref: string) => Record<string, any> | undefined;

/** What the module a call is bound in answers about the names it reaches. */
export interface FunctionScope {
  readonly functions: ModuleFunctionTable;
  readonly resourceInstances: ReadonlyMap<string, { instance: ResourceInstance }>;
  ownModuleName(): string | undefined;
  declaredManifestFor(name: string): ResourceManifest | undefined;
  resolveKind(kind: string): string;
  importedFunctionTarget(
    alias: string,
    name: string,
  ):
    | { readonly status: "no-import" }
    | { readonly status: "not-exported"; readonly declared: boolean }
    | { readonly status: "pending" }
    | {
        readonly status: "ready";
        readonly kind: string;
        readonly instance: ResourceInstance;
        readonly manifest?: ResourceManifest;
      };
}

/** What resolving a call reads from the kernel. */
export interface FunctionResolutionHost {
  /** A registered definition by canonical kind. */
  getDefinition(kind: string): ResourceDefinition | undefined;
  /** A kind resolved in the module that declared the document it is read off. */
  readonly resolveDef: DefResolver;
  readonly shapes: ShapeLookup;
}

/**
 * Bind every module call `resource` makes into the dispatch table of `module` —
 * the module whose names the calls were written with, which for a template body
 * is the library that DEFINED the template. Once per scope per name: a name
 * already bound is not resolved again.
 */
export function bindModuleFunctions(
  module: FunctionScope,
  resource: ResourceManifest,
  host: FunctionResolutionHost,
): void {
  for (const qualified of moduleCallsOf(resource)) {
    module.functions.bind(qualified, () => resolveModuleFunction(module, qualified, resource, host));
  }
}

/**
 * What `qualified` names in `module`, as a dispatch entry — or the refusal or
 * deferral the call earns.
 *
 * The name resolves through the module's own alias table, export gate included:
 * `Self.<name>` / `<Module>.<name>` is a resource this module declares,
 * `<Alias>.<name>` one its import lists in `exports.resources`. The three
 * refusals are the kernel twins of the analyzer's `FUNCTION_UNRESOLVED`,
 * `FUNCTION_NOT_EXPORTED` and `FUNCTION_NOT_CALLABLE`; a callee that exists but has
 * not initialized defers the caller exactly as a pending `!ref` does.
 */
function resolveModuleFunction(
  module: FunctionScope,
  qualified: string,
  caller: ResourceManifest,
  host: FunctionResolutionHost,
): BoundFunction {
  const { receiver, name } = splitQualifiedCall(qualified);
  const site = `${caller.kind}/${(caller.metadata?.name as string | undefined) ?? "<unnamed>"}`;
  const unresolved = (why: string): RuntimeError =>
    new RuntimeError(
      "ERR_FUNCTION_UNRESOLVED",
      `${site}: CEL calls '${qualified}', which names no function this module can reach — ` +
        `${why} A CEL function is a resource declared with capability '${CALLABLE_CAPABILITY}' ` +
        `in the module '${receiver}' names; an imported one must also be listed in that ` +
        `library's 'exports.resources'.`,
    );

  // Decidable from the kind alone, so asked before the instance is: a caller
  // deferring on a resource that could never be called would be reported as
  // blocked by it rather than refused.
  const refuseNotCallable = (kind: string, definition: ResourceDefinition): void => {
    if (isCallableKind(definition, host.resolveDef)) return;
    throw new RuntimeError(
      "ERR_FUNCTION_NOT_CALLABLE",
      `${site}: CEL calls '${qualified}', which names the ${kind} resource '${name}' — its ` +
        `capability resolves to '${inheritedCapability(definition, host.resolveDef) ?? "<none>"}', not ` +
        `'${CALLABLE_CAPABILITY}'. Only a function can be called from an expression; dispatch ` +
        `any other resource from a step.`,
    );
  };
  const bound = (
    holder: string,
    definition: ResourceDefinition,
    manifest: ResourceManifest | undefined,
    instance: ResourceInstance,
  ): BoundFunction => {
    const { params } = resolveSignature(manifest, definition, host.resolveDef);
    return { holder, call: callableEntry(qualified, instance, params, host.shapes) };
  };

  if (receiver === "Self" || receiver === module.ownModuleName()) {
    const manifest = module.declaredManifestFor(name);
    if (!manifest) throw unresolved(`this module declares no resource named '${name}'.`);
    const pending = (why: string): RuntimeError =>
      new RuntimeError(
        "ERR_LOCAL_REF_PENDING",
        `${site}: function '${qualified}' is declared but ${why} (deferring to a later init pass)`,
      );
    let kind: string;
    try {
      kind = module.resolveKind(manifest.kind as string);
    } catch (error) {
      throw pending(
        `its kind '${manifest.kind}' does not resolve yet: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const definition = host.getDefinition(kind);
    if (!definition) throw pending(`its kind '${kind}' is not registered yet`);
    refuseNotCallable(kind, definition);
    const instance = module.resourceInstances.get(name)?.instance;
    if (!instance) throw pending("not initialized yet");
    return bound(name, definition, manifest, instance);
  }

  if (receiver === "Telo") {
    throw unresolved("no built-in module declares a function resource.");
  }

  const target = module.importedFunctionTarget(receiver, name);
  switch (target.status) {
    case "no-import":
      throw unresolved(`'${receiver}' is not an import of this module.`);
    case "not-exported":
      if (!target.declared) {
        throw unresolved(`the library imported as '${receiver}' declares no resource named '${name}'.`);
      }
      throw new RuntimeError(
        "ERR_FUNCTION_NOT_EXPORTED",
        `${site}: CEL calls '${qualified}', but the library imported as '${receiver}' does not ` +
          `list '${name}' in its 'exports.resources', so it is private to that library. Export ` +
          `it there, or call a function the library does export.`,
      );
    case "pending":
      throw new RuntimeError(
        "ERR_CROSS_MODULE_REF_PENDING",
        `${site}: function '${qualified}' is not available yet (import not initialized)`,
      );
    case "ready": {
      const definition = host.getDefinition(target.kind);
      if (!definition) {
        throw new RuntimeError(
          "ERR_CROSS_MODULE_REF_PENDING",
          `${site}: function '${qualified}' is not available yet (its kind '${target.kind}' is not registered)`,
        );
      }
      refuseNotCallable(target.kind, definition);
      return bound(receiver, definition, target.manifest, target.instance);
    }
  }
}

/**
 * The dispatch entry for one callable instance.
 *
 * The positional call is checked against the parameter count and keyed by
 * parameter name through the signature in force for the instance
 * (`callArgumentBinding`, the one binding the analyzer also evaluates a body
 * through). The instance's own signature binding does the rest — defaults,
 * normalization, validation — once, so a body sees the same values at
 * `telo check` and at run time.
 *
 * Whatever the callable throws becomes `ERR_FUNCTION_FAILED` named as the call
 * wrote it, except a failure that already is one (an inner function's, which
 * names the function that actually failed), the binding's own refusals, and a
 * cancellation or suspension, which is the runtime leaving rather than the
 * function failing.
 */
export function callableEntry(
  qualified: string,
  instance: ResourceInstance,
  params: readonly SignatureParam[] | undefined,
  lookup: ShapeLookup,
): ModuleFunction {
  const checked = signatureBoundCallOf(instance);
  if (!checked) {
    throw new RuntimeError(
      "ERR_CONTROLLER_INVALID",
      `Function '${qualified}' resolves to an instance the runtime did not create as a function, so ` +
        `it cannot be called from CEL. A callable kind's controller must return an instance whose ` +
        `\`call\` is a synchronous function.`,
    );
  }
  const binding = callArgumentBinding(qualified, params, undefined, lookup);

  return (args) => {
    const refused = binding.arityRefusal(args.length);
    if (refused) {
      // Structured, so a `try:` sees the code; not ambient, since no kind raises
      // it through a dispatch contract.
      throw new InvokeError("ERR_FUNCTION_ARITY_MISMATCH", refused.message, {
        function: qualified,
        expected: refused.expected,
        required: refused.required,
        passed: args.length,
      });
    }
    try {
      return checked(binding.name(args));
    } catch (error) {
      throw functionFailure(qualified, error);
    }
  };
}
