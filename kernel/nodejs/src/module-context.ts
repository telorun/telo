import { executeInvokeStep, RuntimeError } from "@telorun/sdk";
import type {
  BootTarget,
  ControllerPolicy,
  Invocable,
  InvokeContext,
  InvokeStep,
  InvokeStepContext,
  ModuleContext as IModuleContext,
  ResourceInstance,
} from "@telorun/sdk";
import type { EmitEvent, InstanceFactory } from "@telorun/sdk";
import { EvaluationContext } from "./evaluation-context.js";

/** Wraps process.env so that missing keys return null instead of throwing in CEL.
 * cel-js uses Object.hasOwn(obj, key) before accessing obj[key], so we must
 * intercept getOwnPropertyDescriptor to report every string key as "own".
 * The `constructor` key is special-cased to return `Object` so cel-js's dyn
 * value-type matcher recognises the proxy as a plain map; Node's process.env
 * has an anonymous-function constructor that cel-js otherwise rejects with
 * "Unsupported type: object". */
function lenientEnv(env: Record<string, string | undefined>): Record<string, string | null> {
  return new Proxy(env as Record<string, string | null>, {
    get(target, key) {
      if (typeof key !== "string") return (target as any)[key];
      if (key === "constructor") return Object as unknown as string;
      return key in target ? (target[key] ?? null) : null;
    },
    has() {
      return true;
    },
    getOwnPropertyDescriptor(target, key) {
      if (typeof key !== "string") return Object.getOwnPropertyDescriptor(target, key);
      const value = key in target ? (target[key] ?? null) : null;
      return { configurable: true, enumerable: true, writable: true, value };
    },
  });
}

function collectSecretValues(secrets: Record<string, unknown>): Set<string> {
  const values = new Set<string>();
  for (const value of Object.values(secrets)) {
    if (typeof value === "string" && value.length > 0) {
      values.add(value);
    }
  }
  return values;
}

/** A boot target whose ref slot Phase 5 injection already replaced with the
 *  live instance (the documented "pre-resolved instance once Phase 5 ran"
 *  shape from `BootTarget`). Distinguished from a structural `{kind, name}` ref
 *  by carrying a `run()` method. */
function isRunnableInstance(value: unknown): value is ResourceInstance {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { run?: unknown }).run === "function"
  );
}

/** Cycle-safe serialization for diagnostics. A boot target can be a live
 *  instance whose object graph (e.g. a Kysely/Ajv schema) is cyclic, which
 *  would make a plain JSON.stringify throw and mask the real error. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object") {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}

/**
 * Persistent, module-scoped context. Reserved CEL namespaces:
 * variables, secrets, resources, ports (Application-only).
 *
 * Unlike the base EvaluationContext, ModuleContext is stateful and mutable:
 * variables/secrets/resources accumulate during multi-pass initialization and
 * the context record is rebuilt on each mutation. Import aliases are tracked
 * here for alias-prefixed kind resolution (e.g. MyImport.Http.Route).
 *
 * Imported modules are surfaced under resources.<alias> alongside local
 * resources — no separate imports namespace needed.
 */
export class ModuleContext extends EvaluationContext implements IModuleContext {
  private _variables: Record<string, unknown>;
  private _secrets: Record<string, unknown>;
  private _resources: Record<string, unknown>;
  /** Resolved inbound ports (`ports.<name>` → integer). Application-only:
   *  populated on the root context from the Application's `ports` block;
   *  imported child modules keep this empty. */
  private _ports: Record<string, unknown> = {};

  /** Maps import alias → real module name for kind resolution. */
  private readonly importAliases = new Map<string, string>();

  /** Maps import alias → allowed kind names. Absent entry = unrestricted (e.g. Kernel). */
  private readonly importedKinds = new Map<string, Set<string>>();

  /** Maps import alias → its child context's exported instances. Registered by the
   *  Telo.Import controller; read when resolving a cross-module `!ref Alias.name`
   *  reference (Phase 5 injection and boot targets). `names` is the import's
   *  `exports.resources` gate — only listed instances are reachable. `terminal`
   *  returns the child's pre-flattened terminal getter for a name (a closure that
   *  points directly at the OWNING context's instance, however many re-export hops
   *  away), so resolution stays O(1) regardless of re-export depth. */
  private readonly importedScopes = new Map<
    string,
    {
      names: Set<string>;
      terminal: (
        name: string,
      ) => (() => { kind: string; instance: ResourceInstance } | undefined) | undefined;
    }
  >();

  /** This module's flattened export table: export name → terminal getter. A local
   *  export's getter reads this context's own `resourceInstances`; a re-export
   *  (`!ref Alias.name`) holds the SAME closure object as the owner's entry, copied
   *  by reference at build time so depth adds no resolution hops. Built once by the
   *  Telo.Import controller after this module's own imports have initialized. */
  private readonly exportedGetters = new Map<
    string,
    () => { kind: string; instance: ResourceInstance } | undefined
  >();

  /** This module's flattened exported-KIND table: exported kind suffix → canonical
   *  `<owningModule>.<Kind>`. A local exported kind maps to `<thisModule>.<Kind>`; a
   *  re-export (`exports.kinds: [Alias.Kind]`) copies the source import's already-canonical
   *  string, so depth adds no resolution hops. Built by `buildExportTable`. */
  private readonly exportedKinds = new Map<string, string>();

  /** Maps import alias → a resolver into that import's exported-kind table. Registered by the
   *  Telo.Import controller; consulted by `resolveKind` so an imported library's kinds — local
   *  OR transitively re-exported — resolve to their true owning module in O(1). */
  private readonly importedKindResolvers = new Map<string, (suffix: string) => string | undefined>();

  /**
   * Resolved controller-selection policy for this module's `Telo.Definition`s.
   * Stamped by the parent `Telo.Import` controller from the import's `runtime:`
   * field; read by `Telo.Definition.init` (via `ResourceContext.getControllerPolicy`)
   * when invoking `ControllerLoader.load`. `undefined` means "no policy set" —
   * loader treats it as `auto`.
   */
  private _controllerPolicy: ControllerPolicy | undefined;

  constructor(
    source: string,
    variables: Record<string, unknown> = {},
    secrets: Record<string, unknown> = {},
    resources: Record<string, unknown> = {},
    private targets: BootTarget[] = [],
    createInstance: InstanceFactory = async () => null,
    emit: EmitEvent,
    private readonly _hostEnv?: Record<string, string | undefined>,
  ) {
    super(source, {}, createInstance, new Set(), emit);
    this._variables = variables;
    this._secrets = secrets;
    this._resources = resources;
    this._rebuildContext();
  }

  get variables(): Record<string, unknown> {
    return this._variables;
  }

  get secrets(): Record<string, unknown> {
    return this._secrets;
  }

  get resources(): Record<string, unknown> {
    return this._resources;
  }

  get ports(): Record<string, unknown> {
    return this._ports;
  }

  setVariables(vars: Record<string, unknown>): void {
    this._variables = vars;
    this._rebuildContext();
  }

  setPorts(ports: Record<string, unknown>): void {
    this._ports = ports;
    this._rebuildContext();
  }

  setTargets(vars: BootTarget[]): void {
    this.targets = vars;
  }

  setSecrets(secrets: Record<string, unknown>): void {
    this._secrets = secrets;
    this._rebuildContext();
  }

  setResource(name: string, props: Record<string, unknown>): void {
    this._resources = { ...this._resources, [name]: props };
    this._rebuildContext();
  }

  setControllerPolicy(policy: ControllerPolicy | undefined): void {
    this._controllerPolicy = policy;
  }

  getControllerPolicy(): ControllerPolicy | undefined {
    return this._controllerPolicy;
  }

  protected override onResourceSnapshotted(name: string, snap: Record<string, unknown>): void {
    this.setResource(name, snap);
  }

  /**
   * Register an imported module under the given alias, with the list of kind names
   * it exports. An empty kinds array means no restriction (used for built-ins like Telo).
   */
  registerImport(alias: string, targetModule: string, kinds: string[]): void {
    this.importAliases.set(alias, targetModule);
    if (kinds.length > 0) {
      this.importedKinds.set(alias, new Set(kinds));
    }
  }

  /** Register an import alias's exported instances for cross-module reference resolution.
   *  `names` is the gate (the import's `exports.resources`); `terminal` returns the child
   *  context's pre-flattened terminal getter for a name (existing only after the import's
   *  `init()` built the child's export table). */
  registerImportedScope(
    alias: string,
    names: string[],
    terminal: (
      name: string,
    ) => (() => { kind: string; instance: ResourceInstance } | undefined) | undefined,
  ): void {
    this.importedScopes.set(alias, { names: new Set(names), terminal });
  }

  /** This module's terminal getter for an exported `name`, or undefined. Read by a parent
   *  import building its own (re-)export table — copying this closure by reference flattens
   *  the chain so resolution never walks hops. */
  getTerminalExport(
    name: string,
  ): (() => { kind: string; instance: ResourceInstance } | undefined) | undefined {
    return this.exportedGetters.get(name);
  }

  /** O(1) resolution of an exported instance owned or re-exported by this module. */
  getExported(name: string): { kind: string; instance: ResourceInstance } | undefined {
    return this.exportedGetters.get(name)?.();
  }

  /** Register an import alias's exported-kind resolver (the child's `getExportedKind`). */
  registerImportedKindScope(alias: string, resolve: (suffix: string) => string | undefined): void {
    this.importedKindResolvers.set(alias, resolve);
  }

  /** This module's canonical kind for an exported suffix (local or re-exported), or undefined. */
  getExportedKind(suffix: string): string | undefined {
    return this.exportedKinds.get(suffix);
  }

  /** Build this module's flattened export tables from `exports.resources` / `exports.kinds`.
   *  A resource entry is a local export (no alias) or a re-export `Alias.Name` (alias set); a
   *  kind entry is a local kind (no alias) or a re-export `Alias.Kind` (alias set). A local
   *  export gets a fresh terminal getter / `<module>.<Kind>` canonical; a re-export copies the
   *  source import's terminal getter / already-canonical kind by reference, collapsing the chain
   *  to a single hop. Called once by the Telo.Import controller after this module's own imports
   *  have initialized (leaves-first), so re-export sources are already registered — an
   *  unresolvable re-export is therefore a permanent misconfiguration and throws here. */
  buildExportTable(
    entries: ReadonlyArray<{ name: string; alias?: string }>,
    kindEntries: ReadonlyArray<{ name: string; alias?: string }>,
    moduleName: string,
  ): void {
    for (const entry of entries) {
      const name = entry.name;
      if (entry.alias && entry.alias !== "Self") {
        // A re-export resolves against this module's own imports, which have all initialized
        // by now (leaves-first) — so an unresolved source is a permanent misconfiguration, not
        // a transient miss. Surface it instead of silently dropping the export.
        const scope = this.importedScopes.get(entry.alias);
        if (!scope) {
          throw new RuntimeError(
            "ERR_INVALID_REEXPORT",
            `Library '${moduleName}' re-exports '${entry.alias}.${name}' but declares no import ` +
              `aliased '${entry.alias}'. Add it to this library's 'imports', or remove the ` +
              `'exports.resources' entry.`,
          );
        }
        const terminal = scope.terminal(name);
        if (!terminal) {
          throw new RuntimeError(
            "ERR_INVALID_REEXPORT",
            `Library '${moduleName}' re-exports '${entry.alias}.${name}', but the imported ` +
              `library '${entry.alias}' exports no instance named '${name}'.`,
          );
        }
        this.exportedGetters.set(name, terminal);
        continue;
      }
      this.exportedGetters.set(name, () => {
        const inst = this.resourceInstances.get(name);
        if (!inst) return undefined;
        // Canonicalize the authored kind to `<module>.<Kind>` so the cross-module ref shape
        // and event naming are scope-independent (matches resolve-ref-sentinels.ts).
        const rawKind = inst.resource.kind as string;
        const kind = rawKind.startsWith("Self.")
          ? `${moduleName}.${rawKind.slice("Self.".length)}`
          : rawKind;
        return { kind, instance: inst.instance };
      });
    }
    for (const k of kindEntries) {
      if (k.alias && k.alias !== "Self") {
        const resolver = this.importedKindResolvers.get(k.alias);
        if (!resolver) {
          throw new RuntimeError(
            "ERR_INVALID_REEXPORT",
            `Library '${moduleName}' re-exports kind '${k.alias}.${k.name}' but declares no ` +
              `import aliased '${k.alias}'. Add it to this library's 'imports', or remove the ` +
              `'exports.kinds' entry.`,
          );
        }
        const canonical = resolver(k.name);
        if (!canonical) {
          throw new RuntimeError(
            "ERR_INVALID_REEXPORT",
            `Library '${moduleName}' re-exports kind '${k.alias}.${k.name}', but the imported ` +
              `library '${k.alias}' exports no kind named '${k.name}'.`,
          );
        }
        this.exportedKinds.set(k.name, canonical);
        continue;
      }
      this.exportedKinds.set(k.name, `${moduleName}.${k.name}`);
    }
  }

  /** Resolve `Alias.name` to a live exported instance, gated by `exports.resources`.
   *  Returns undefined when the alias is unknown, the name isn't exported, or the import
   *  hasn't built its export table yet (the injection path defers and retries). O(1). */
  override resolveImportedInstance(alias: string, name: string): ResourceInstance | undefined {
    const scope = this.importedScopes.get(alias);
    if (!scope || !scope.names.has(name)) return undefined;
    return scope.terminal(name)?.()?.instance;
  }

  /** Like `resolveImportedInstance`, but returns the `{kind, name}` ref (canonical kind)
   *  for controllers that resolve step/handler invokes to refs rather than live instances
   *  (e.g. Run.Sequence via `resolveChildren`). The alias is reattached by the caller. */
  resolveImportedRef(alias: string, name: string): { kind: string; name: string } | undefined {
    const scope = this.importedScopes.get(alias);
    if (!scope || !scope.names.has(name)) return undefined;
    const entry = scope.terminal(name)?.();
    return entry ? { kind: entry.kind, name } : undefined;
  }

  hasImport(alias: string): boolean {
    return this.importAliases.has(alias);
  }

  getInstance(name: string): unknown {
    const entry = this.resourceInstances.get(name);
    if (!entry) {
      throw new Error(
        `Resource '${name}' not found in module context. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
      );
    }
    return entry?.instance;
  }

  getInvocable<TInput = Record<string, any>, TOutput = any>(
    name: string,
  ): Invocable<TInput, TOutput> {
    const instance = this.getInstance(name);

    if (typeof (instance as any)?.invoke !== "function") {
      throw new Error(`Resource '${name}' does not have an invoke() method.`);
    }
    return instance as Invocable<TInput, TOutput>;
  }

  /**
   * Resolve a fully-qualified kind like "Http.Server" to its real kind "http-server.Server".
   * Splits on the first dot, looks up the prefix in importAliases, validates against
   * importedKinds (if set), and reconstructs the resolved kind. When the alias is not
   * present locally, walks up the lifecycle parent chain so children inherit ancestors'
   * imports (notably the root's `Telo` built-in). Sibling modules — being absent from the
   * chain — remain isolated.
   * Throws with a clear message if the alias is unknown or the kind is not exported.
   */
  resolveKind(kind: string): string {
    const dot = kind.indexOf(".");
    if (dot === -1) {
      throw new Error(`Kind '${kind}' must be fully qualified (e.g. 'Module.KindName')`);
    }
    const prefix = kind.slice(0, dot);
    const suffix = kind.slice(dot + 1);
    const realModule = this.importAliases.get(prefix);
    if (!realModule) {
      let cur = this.parent;
      while (cur) {
        if (cur instanceof ModuleContext) return cur.resolveKind(kind);
        cur = cur.parent;
      }
      const known = [...this.importAliases.keys()].join(", ") || "(none)";
      throw new Error(
        `Kind '${kind}': no module imported with alias '${prefix}'. Known aliases: ${known}`,
      );
    }
    const allowed = this.importedKinds.get(prefix);
    if (allowed !== undefined && !allowed.has(suffix)) {
      throw new Error(
        `Kind '${suffix}' is not exported by module '${realModule}' (imported as '${prefix}'). ` +
          `Exported kinds: ${[...allowed].join(", ")}`,
      );
    }
    // Re-export override: if this import's exported-kind table maps the suffix to a DIFFERENT
    // owning module, the kind is transitively re-exported (`exports.kinds: [Alias.Kind]`) —
    // resolve to its true owner. A local kind maps to `${realModule}.${suffix}` (no override),
    // and a module without `exports.kinds` has an empty table (unrestricted, unchanged). Built
    // deferred, so before the import inits this returns the un-overridden kind, whose controller
    // miss makes the init loop retry until the table is ready.
    const reExported = this.importedKindResolvers.get(prefix)?.(suffix);
    if (reExported && reExported !== `${realModule}.${suffix}`) return reExported;
    return `${realModule}.${suffix}`;
  }

  private _rebuildContext(): void {
    this._context = {
      variables: this._variables,
      secrets: this._secrets,
      resources: this._resources,
      ports: this._ports,
      ...(this._hostEnv ? { env: lenientEnv(this._hostEnv) } : {}),
    };
    this._secretValues = collectSecretValues(this._secrets);
  }

  override async invoke<TInputs>(
    kind: string,
    name: string,
    inputs: TInputs,
    ctx?: InvokeContext,
  ): Promise<any> {
    const result = await super.invoke(kind, name, inputs, ctx);
    const entry = this.resourceInstances.get(name);
    if (entry && typeof (entry.instance as any).snapshot === "function") {
      const snap = await Promise.resolve((entry.instance as any).snapshot());
      this.setResource(name, snap as Record<string, unknown>);
    }
    return result;
  }

  override async run(name: string, ctx?: InvokeContext) {
    const resource = this.resourceInstances.get(name);
    if (!resource) {
      throw new Error(
        `Target resource ${name} not found in module context. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
      );
    }
    if (typeof resource.instance.run !== "function") {
      throw new Error(`Target resource ${name} does not have a run() method.`);
    }
    // Delegate execution to the base run(), which applies the cancellation gate
    // and scope; the checks above keep the module-scoped error messages.
    await super.run(name, ctx);
  }

  async runTargets(ctx?: InvokeContext) {
    const steps: Record<string, unknown> = {};
    const stepCtx: InvokeStepContext = {
      expandValue: (value, context) => this.expandWith(value, context),
      invoke: (kind, name, inputs) => this.invoke(kind, name, inputs, ctx),
      invokeResolved: (kind, name, instance, inputs) =>
        this.invokeResolved(kind, name, instance, inputs, ctx),
      resolveImportedInstance: (alias, name) => this.resolveImportedInstance(alias, name),
    };
    // Mirror the local-run gate: refuse a target reached after the boot run was
    // cancelled, then run the pre-resolved instance directly.
    const runResolvedInstance = async (inst: ResourceInstance, label: string) => {
      const token = ctx?.cancellation;
      if (token?.isCancelled) {
        throw new RuntimeError(
          "ERR_INVOKE_CANCELLED",
          `Run ${label} was cancelled${token.reason ? `: ${token.reason}` : ""}`,
        );
      }
      await inst.run!(ctx);
    };
    for (let i = 0; i < this.targets.length; i++) {
      const target = this.targets[i]!;
      if (typeof target === "string") {
        await this.run(target, ctx);
        continue;
      }
      // A bare `!ref Alias.name` boot target is Phase-5-injected into the live
      // instance, which for a Run.Sequence exposes both `run()` and `invoke()`.
      // Guard against treating such an instance as an authored inline-invoke
      // step — only a structural `{ invoke: <ref>, inputs }` spec (no `run`)
      // belongs here; the live instance falls through to the runnable branch.
      if (!isRunnableInstance(target) && "invoke" in target && target.invoke !== undefined) {
        const step: InvokeStep = {
          name: target.name ?? `Target${i}`,
          when: target.when,
          // A cross-module `!ref Alias.name` stays a `{kind, name, alias}` ref; the leaf's
          // alias branch resolves it via `resolveImportedInstance` and dispatches through
          // `invokeResolved` so invocation events and error wrapping still fire.
          invoke: target.invoke,
          inputs: target.inputs,
        };
        await executeInvokeStep(step, stepCtx, { steps });
        continue;
      }
      if ("ref" in target && target.ref != null) {
        if (target.when === undefined || this.expandWith(target.when, { steps })) {
          const ref = target.ref as unknown;
          // Phase 5 injection may have replaced the ref slot with the live
          // instance; run it directly.
          if (isRunnableInstance(ref)) {
            await runResolvedInstance(ref, `target[${i}]`);
          } else {
            const r =
              ref && typeof ref === "object"
                ? (ref as { name: string; alias?: string })
                : undefined;
            if (r && typeof r.alias === "string" && r.alias !== "Self") {
              const inst = this.resolveImportedInstance(r.alias, r.name);
              if (!inst || typeof inst.run !== "function") {
                throw new Error(
                  `Boot target '${r.alias}.${r.name}' is not a runnable exported instance`,
                );
              }
              await runResolvedInstance(inst, `${r.alias}.${r.name}`);
            } else {
              await this.run(typeof ref === "string" ? ref : r!.name, ctx);
            }
          }
        }
        continue;
      }
      // Bare run target. Phase 5 injection resolves a `!ref name` /
      // cross-module `!ref Alias.name` slot into the live instance before boot,
      // so the common runtime shape here is a pre-resolved ResourceInstance;
      // fall back to the structural ref forms when injection left them in place.
      if (isRunnableInstance(target)) {
        await runResolvedInstance(target, `target[${i}]`);
        continue;
      }
      const bare = target as { name?: unknown; alias?: unknown };
      if (typeof bare.alias === "string" && bare.alias !== "Self" && typeof bare.name === "string") {
        const inst = this.resolveImportedInstance(bare.alias, bare.name);
        if (!inst || typeof inst.run !== "function") {
          throw new Error(
            `Boot target '${bare.alias}.${bare.name}' is not a runnable exported instance`,
          );
        }
        await runResolvedInstance(inst, `${bare.alias}.${bare.name}`);
        continue;
      }
      if (typeof bare.name === "string") {
        await this.run(bare.name, ctx);
        continue;
      }
      throw new Error(`Unrecognized target shape at index ${i}: ${safeStringify(target)}`);
    }
  }
}
