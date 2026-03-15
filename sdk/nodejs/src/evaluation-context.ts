import { evaluate } from "@marcbachmann/cel-js";
import type { ModuleContext } from "./module-context.js";
import { ResourceInstance } from "./resource-instance.js";
import { ResourceManifest } from "./resource-manifest.js";
import { RuntimeError } from "./types.js";

export type EmitEvent = (event: string, payload?: any) => void | Promise<void>;

const TEMPLATE_REGEX = /\$\{\{\s*([^}]+?)\s*\}\}/g;
const EXACT_TEMPLATE_REGEX = /^\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/;

/** Four-stage resource lifecycle defined in resource-lifecycle.md */
export type LifecycleState = "Pending" | "Validated" | "Initialized" | "Draining" | "Teardown";

/**
 * Result of the create phase: the instance and its bound ResourceContext.
 * The ctx is typed as any to avoid a circular import with resource-context.ts.
 */
export type CreatedResource = { instance: ResourceInstance; ctx: any };

/**
 * Creates a ResourceInstance for the given manifest, or returns null if not yet
 * ready (e.g. a dependency is still initializing). Injected at construction so
 * every EvaluationContext node owns its full resource lifecycle.
 * Returns a CreatedResource (instance + ctx) so initializeResources can run
 * init() separately in a second phase.
 */
export type InstanceFactory = (
  moduleContext: ModuleContext,
  resource: ResourceManifest,
) => Promise<CreatedResource | null>;

/** Canonical key for a resource instance: "<module>.<kind>.<name>" */
export function resourceKey(r: ResourceManifest): string {
  return `${r.kind}.${r.metadata.name}`;
}

function redactSecrets(message: string, secretValues: Set<string>): string {
  if (secretValues.size === 0) return message;
  const sorted = Array.from(secretValues).sort((a, b) => b.length - a.length);
  let result = message;
  for (const secret of sorted) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

/**
 * Base class for all evaluation contexts. Owns CEL evaluation, template
 * expansion, secrets redaction, and the generic resource lifecycle tree.
 *
 * Every EvaluationContext node can:
 *   - Hold its own resource instances (resourceInstances)
 *   - Queue resources for initialization (pendingResources)
 *   - Spawn child contexts (spawnChild) forming a lifecycle tree
 *   - Run a multi-pass initialization loop (initializeResources)
 *   - Cascade teardown depth-first through the tree (teardownResources)
 */
export class EvaluationContext {
  readonly id = Math.random().toString(16).slice(2, 8);
  protected _context: Record<string, unknown>;
  protected _secretValues: Set<string>;
  protected _createInstance: InstanceFactory;
  readonly emit: EmitEvent;

  /** Position in the lifecycle tree. */
  parent: EvaluationContext | undefined = undefined;
  readonly children: EvaluationContext[] = [];

  /** Current lifecycle state of this context node. */
  state: LifecycleState = "Pending";

  /** Resource instances owned by this context node, keyed by resourceKey(). */
  readonly resourceInstances = new Map<
    string,
    { resource: ResourceManifest; instance: ResourceInstance }
  >();

  /** Resources that have been created but not yet initialized (between phases). */
  protected readonly createdInstances = new Map<
    string,
    { resource: ResourceManifest; instance: ResourceInstance; ctx: any }
  >();

  /** Resources queued for initialization on this context node. */
  private pendingResources: ResourceManifest[] = [];

  constructor(
    readonly source: string,
    context: Record<string, unknown>,
    createInstance: InstanceFactory = async () => null,
    secretValues: Set<string>,
    emit: EmitEvent,
  ) {
    this._context = context;
    this._createInstance = createInstance;
    this._secretValues = secretValues ?? new Set();
    this.emit = emit;
  }

  get createInstance(): InstanceFactory {
    return this._createInstance;
  }

  /** Called after init() when a resource snapshot is available. Overridden by ModuleContext. */
  protected onResourceSnapshotted(_name: string, _snap: Record<string, unknown>): void {}

  get context(): Record<string, unknown> {
    return this._context;
  }

  get secretValues(): Set<string> {
    return this._secretValues;
  }

  /**
   * Queue a resource manifest for initialization on this context.
   */
  registerManifest(resource: ResourceManifest): void {
    if (!resource.metadata) {
      resource.metadata = { name: `__unnamed_${Math.random().toString(16).slice(2, 8)}` };
    }
    const name = resource.metadata.name;
    if (
      this.resourceInstances.has(name) ||
      this.createdInstances.has(name) ||
      this.pendingResources.some((r) => r.metadata.name === name)
    ) {
      throw new RuntimeError("ERR_DUPLICATE_RESOURCE", `Resource '${name}' is already registered`);
    }
    this.pendingResources.push(resource);
  }

  /**
   * Attach a child context to this node. The child's parent is set to this
   * context and the child is registered under the given name.
   */
  spawnChild<T extends EvaluationContext>(child: T): T {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  /**
   * Interleaved create/init loop.
   *
   * Each pass has two sub-phases run back-to-back:
   *   1. Create sub-phase: call controller.create() for each pending resource that
   *      hasn't been created yet. Successful results go into createdInstances.
   *   2. Init sub-phase: call instance.init(ctx) for each created-but-not-inited
   *      resource. Successful results go into resourceInstances.
   *
   * Interleaving is necessary because some resources' create() depends on effects
   * produced by other resources' init() (e.g. Kernel.Import.init() runs
   * child.initializeResources() which registers controllers needed by sibling
   * resources' create()). Running both sub-phases each pass lets those effects
   * propagate before the next create attempt.
   *
   * Each resource is created at most once and inited at most once.
   * ERR_VISIBILITY_DENIED is fatal and re-thrown immediately.
   * All other errors are tracked and retried until no progress is made.
   */
  async initializeResources(): Promise<void> {
    const MAX_PASSES = 10;
    const errors = new Map<string, string>();

    let pass = 1;
    do {
      let progress = false;

      // Create sub-phase
      for (const resource of [...this.pendingResources]) {
        const name = resource.metadata.name;
        if (this.createdInstances.has(name)) continue;
        try {
          // const expanded = this.expand(resource) as ResourceManifest;
          // FIXME: Cannot expand it for all resources, needs to be selective
          const created = await this._createInstance(this as any, resource);
          if (created) {
            this.createdInstances.set(name, {
              resource,
              instance: created.instance,
              ctx: created.ctx,
            });
            const idx = this.pendingResources.findIndex((m) => m.metadata.name === name);
            if (idx >= 0) this.pendingResources.splice(idx, 1);
            errors.delete(name);
            progress = true;
          }
        } catch (error) {
          if (error instanceof RuntimeError && error.code === "ERR_VISIBILITY_DENIED") throw error;
          errors.set(name, error instanceof Error ? (error.stack ?? error.message) : String(error));
        }
      }

      // Init sub-phase
      for (const [name, { resource, instance, ctx }] of [...this.createdInstances]) {
        if (this.resourceInstances.has(name)) continue;
        try {
          if (instance.init) await instance.init(ctx);
          if (instance.snapshot) {
            const snap = await Promise.resolve(instance.snapshot()).catch(() => ({}));
            this.onResourceSnapshotted(name, (snap as Record<string, unknown>) ?? {});
          }
          this.resourceInstances.set(name, { resource, instance });
          this.createdInstances.delete(name);
          errors.delete(name);
          progress = true;
        } catch (error) {
          if (error instanceof RuntimeError && error.code === "ERR_VISIBILITY_DENIED") throw error;
          errors.set(name, error instanceof Error ? (error.stack ?? error.message) : String(error));
        }
      }

      pass++;
      if (!progress) break;
    } while (pass <= MAX_PASSES);

    if (this.pendingResources.length > 0 || this.createdInstances.size > 0) {
      const pending = this.pendingResources.map(
        (r) => `- ${r.metadata.name}: ${errors.get(r.metadata.name) ?? "Unknown error"}`,
      );
      const created = [...this.createdInstances.keys()].map(
        (name) => `- ${name}: ${errors.get(name) ?? "Unknown error"}`,
      );
      const unhandledList = [...pending, ...created].join("\n");
      throw new RuntimeError(
        "ERR_RESOURCE_INITIALIZATION_FAILED",
        `Unable to process resources:\n\n${unhandledList}`,
      );
    }

    this.state = "Initialized";
  }

  withManifests<T>(manifests: any[], fn: () => T): T {
    const child = this.spawnChild(
      new EvaluationContext(
        this.source,
        this._context,
        this._createInstance,
        this._secretValues,
        this.emit,
      ),
    );
    try {
      for (const manifest of manifests) {
        child.registerManifest(manifest);
      }
      return fn();
    } finally {
      // Tear down child context and its resources immediately after fn() completes.
      // Note that this does NOT emit Kernel-level events (e.g. Teardown events) —
      // they remain the Kernel's responsibility.
      child.teardownResources();
    }
  }

  /**
   * Cascade teardown depth-first through the tree:
   *   1. Tear down child contexts in reverse registration order.
   *   2. Tear down own resource instances in reverse registration order,
   *      emitting a Teardown event for each via the injected emit callback.
   */
  async teardownResources(): Promise<void> {
    this.state = "Draining";
    for (const child of [...this.children].reverse()) {
      await child.teardownResources();
    }
    const entries = [...this.resourceInstances.entries()].reverse();
    for (const [key, { resource, instance }] of entries) {
      if (instance.teardown) await instance.teardown();
      await this.emit(`${resource.kind}.${resource.metadata.name}.Teardown`, {
        resource: { kind: resource.kind, name: resource.metadata.name },
      });
      this.resourceInstances.delete(key);
    }
    this.state = "Teardown";
  }

  transientChild(context: Record<string, any>): EvaluationContext {
    return new EvaluationContext(
      this.source,
      { ...this.context, ...context },
      this._createInstance,
      this._secretValues,
      this.emit,
    );
  }

  /**
   * Invoke a resource by kind and name within this context's resourceInstances.
   * Emits a scoped Invoked event via the injected emit callback after invocation.
   */
  async invoke<TInputs>(kind: string, name: string, inputs: TInputs): Promise<any> {
    const entry = this.resourceInstances.get(name);

    if (entry) {
      if (typeof entry.instance.invoke !== "function") {
        throw new RuntimeError(
          "ERR_RESOURCE_NOT_INVOKABLE",
          `Resource ${kind}.${name} does not have an invoke method`,
        );
      }
      const outputs = await entry.instance.invoke(inputs);
      await this.emit(`${kind}.${name}.Invoked`, { outputs });
      return outputs;
    }

    throw new RuntimeError(
      "ERR_RESOURCE_NOT_FOUND",
      `Resource not found for invocation: ${kind}.${name}. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
    );
  }

  async run(name: string): Promise<void> {
    const entry = this.resourceInstances.get(name);
    if (entry && typeof entry.instance.run === "function") {
      return entry.instance.run();
    }
    throw new RuntimeError(
      "ERR_RESOURCE_NOT_RUNNABLE",
      `Resource ${name} is not runnable or not found. Available resources: ${[...this.resourceInstances.keys()].join(", ")}`,
    );
  }

  /**
   * Evaluate a single CEL expression string against the context.
   * Secret values are redacted from any thrown error message.
   */
  evaluate(expression: string): unknown {
    try {
      return evaluate(expression, this._context);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const safe = redactSecrets(raw, this._secretValues);
      throw new Error(`CEL evaluation failed: "${expression}": ${safe}`);
    }
  }

  /**
   * Expand a value that may contain ${{ }} templates.
   * Works recursively over strings, arrays, and objects.
   */
  expand(value: unknown): unknown {
    if (typeof value === "string") {
      return this.expandString(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.expand(entry));
    }
    if (value !== null && typeof value === "object") {
      const resolved: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        resolved[key] = this.expand(entry);
      }
      return resolved;
    }
    return value;
  }

  /**
   * Expand a value using this context merged with additional properties.
   * Equivalent to merge(extraContext).expand(value) without allocating a context object.
   */
  expandWith(value: unknown, extraContext: Record<string, unknown>): unknown {
    const saved = this._context;
    this._context = Object.assign(Object.create(null), saved, extraContext) as Record<
      string,
      unknown
    >;
    try {
      return this.expand(value);
    } finally {
      this._context = saved;
    }
  }

  private expandString(value: string): unknown {
    if (!value.includes("${{")) {
      return value;
    }

    const exact = value.match(EXACT_TEMPLATE_REGEX);
    if (exact) {
      return this.evaluate(exact[1]);
    }

    return value.replace(TEMPLATE_REGEX, (_match, expr: string) => {
      const resolved = this.evaluate(expr);
      if (resolved === null || resolved === undefined) {
        return "";
      }
      return String(resolved);
    });
  }

  /**
   * Expand specific dot-paths within an object. '**' expands the entire object.
   * Paths listed in excludePaths are left untouched (runtime takes precedence).
   * Always throws if an expression cannot be resolved.
   */
  expandPaths(
    value: Record<string, unknown>,
    paths: string[],
    excludePaths: string[] = [],
  ): Record<string, unknown> {
    if (paths.includes("**")) {
      const result: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        result[key] = isExcluded(key, excludePaths) ? v : this.expand(v);
      }
      return result;
    }
    const result = { ...value };
    for (const path of paths) {
      if (isExcluded(path, excludePaths)) continue;
      const parts = path.split(".");
      const current = getNestedValue(result, parts);
      if (current !== undefined) {
        setNestedValue(result, parts, this.expand(current));
      }
    }
    return result;
  }
}

function isExcluded(path: string, excludePaths: string[]): boolean {
  return excludePaths.some(
    (ep) => ep === path || ep === "**" || path.startsWith(ep + ".") || ep.startsWith(path + "."),
  );
}

function getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = current[parts[i]];
    if (next === null || typeof next !== "object") return;
    current = next as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
