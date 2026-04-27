import type {
  ControllerPolicy,
  Invocable,
  ModuleContext as IModuleContext,
} from "@telorun/sdk";
import type { EmitEvent, InstanceFactory } from "@telorun/sdk";
import { EvaluationContext } from "./evaluation-context.js";

/** Wraps process.env so that missing keys return null instead of throwing in CEL.
 * Some CEL backends use Object.hasOwn(obj, key) before accessing obj[key], so we
 * intercept getOwnPropertyDescriptor to report every string key as "own". */
function lenientEnv(env: Record<string, string | undefined>): Record<string, string | null> {
  return new Proxy(env as Record<string, string | null>, {
    get(target, key) {
      if (typeof key !== "string") return (target as any)[key];
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

/**
 * Persistent, module-scoped context. Three reserved CEL namespaces:
 * variables, secrets, resources.
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

  /** Maps import alias → real module name for kind resolution. */
  private readonly importAliases = new Map<string, string>();

  /** Maps import alias → allowed kind names. Absent entry = unrestricted (e.g. Kernel). */
  private readonly importedKinds = new Map<string, Set<string>>();

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
    private targets: string[] = [],
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

  setVariables(vars: Record<string, unknown>): void {
    this._variables = vars;
    this._rebuildContext();
  }

  setTargets(vars: string[]): void {
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
    return `${realModule}.${suffix}`;
  }

  private _rebuildContext(): void {
    this._context = {
      variables: this._variables,
      secrets: this._secrets,
      resources: this._resources,
      ...(this._hostEnv ? { env: lenientEnv(this._hostEnv) } : {}),
    };
    this._secretValues = collectSecretValues(this._secrets);
  }

  override async invoke<TInputs>(kind: string, name: string, inputs: TInputs): Promise<any> {
    const result = await super.invoke(kind, name, inputs);
    const entry = this.resourceInstances.get(name);
    if (entry && typeof (entry.instance as any).snapshot === "function") {
      const snap = await Promise.resolve((entry.instance as any).snapshot());
      this.setResource(name, snap as Record<string, unknown>);
    }
    return result;
  }

  async run(name: string) {
    const resource = this.resourceInstances.get(name);
    if (!resource) {
      throw new Error(
        `Target resource ${name} not found in module context. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
      );
    }
    if (typeof resource.instance.run === "function") {
      await resource.instance.run();
    } else {
      throw new Error(`Target resource ${name} does not have a run() method.`);
    }
  }

  async runTargets() {
    for (const target of this.targets) {
      await this.run(target);
    }
  }
}
