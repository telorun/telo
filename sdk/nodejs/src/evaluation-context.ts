import { evaluate } from "cel-js";
import { ModuleContext } from "./module-context.js";
import { ResourceInstance } from "./resource-instance.js";
import { ResourceManifest } from "./resource-manifest.js";
import { RuntimeError } from "./types.js";

export type EmitEvent = (event: string, payload?: any) => void | Promise<void>;

const TEMPLATE_REGEX = /\$\{\{\s*([^}]+?)\s*\}\}/g;
const EXACT_TEMPLATE_REGEX = /^\s*\$\{\{\s*([^}]+?)\s*\}\}\s*$/;

/** Four-stage resource lifecycle defined in resource-lifecycle.md */
export type LifecycleState = "Pending" | "Validated" | "Initialized" | "Draining" | "Teardown";

/**
 * Creates a ResourceInstance for the given manifest, or returns null if not yet
 * ready (e.g. a dependency is still initializing). Injected at construction so
 * every EvaluationContext node owns its full resource lifecycle.
 */
export type InstanceFactory = (
  moduleContext: ModuleContext,
  resource: ResourceManifest,
) => Promise<ResourceInstance | null>;

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
   * Multi-pass initialization loop. Processes pendingResources by calling the
   * supplied instantiator for each resource, retrying failures across up to 10
   * passes (handles dependency ordering without explicit topological sort).
   *
   * ERR_VISIBILITY_DENIED errors are fatal and re-thrown immediately.
   * All other errors are tracked and retried until no progress is made.
   */
  async initializeResources(): Promise<void> {
    const MAX_PASSES = 10;
    let pass = 1;
    const errors = new Map<string, string>();

    do {
      const handled: string[] = [];

      for (const resource of [...this.pendingResources]) {
        // const rkey = resourceKey(resource);
        // const displayKey = rkey;
        const name = resource.metadata.name;
        if (this.resourceInstances.has(name)) continue;

        try {
          const instance = await this._createInstance(this as any, resource);
          if (instance) {
            this.resourceInstances.set(name, { resource, instance });
            handled.push(name);
            errors.delete(name);
          }
        } catch (error) {
          if (error instanceof RuntimeError && error.code === "ERR_VISIBILITY_DENIED") throw error;
          errors.set(name, error instanceof Error ? (error.stack ?? error.message) : String(error));
        }
      }

      for (const name of handled) {
        const resource = this.pendingResources.find((m) => m.metadata.name === name)!;
        const idx = this.pendingResources.indexOf(resource);
        if (idx >= 0) this.pendingResources.splice(idx, 1);
      }

      pass++;
      if (handled.length === 0) break;
    } while (pass <= MAX_PASSES);

    if (this.pendingResources.length > 0) {
      const unhandledList = this.pendingResources
        .reverse()
        .map((r) => `- ${r.metadata.name}: ${errors.get(r.metadata.name) ?? "Unknown error"}`)
        .join("\n");

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
   *   2. Tear down own resource instances in reverse registration order.
   *
   * Note: Kernel-level events (e.g. Teardown events) are NOT emitted here —
   * they remain the Kernel's responsibility.
   */
  async teardownResources(): Promise<void> {
    this.state = "Draining";
    for (const child of [...this.children].reverse()) {
      await child.teardownResources();
    }
    const entries = [...this.resourceInstances.entries()].reverse();
    for (const [key, { instance }] of entries) {
      if (instance.teardown) await instance.teardown();
      this.resourceInstances.delete(key);
    }
    this.state = "Teardown";
  }

  /**
   * Invoke a resource by kind and name within this context's resourceInstances.
   * Emits a scoped Invoked event via the injected emit callback after invocation.
   */
  async invoke(kind: string, name: string, ...args: any[]): Promise<any> {
    const entry = this.resourceInstances.get(name);

    if (entry) {
      if (typeof entry.instance.invoke !== "function") {
        throw new RuntimeError(
          "ERR_RESOURCE_NOT_INVOKABLE",
          `Resource ${kind}.${name} does not have an invoke method`,
        );
      }
      const outputs = await entry.instance.invoke(args[0]);
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
   * Templates whose identifiers are not present in the context are left
   * unchanged (deferred) — they will be resolved at execution time when a
   * richer ExecutionContext is available. All other CEL errors are propagated.
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
   * Merge another context on top of this one.
   * Returns a new base EvaluationContext — 'other' wins on key conflict.
   */
  merge(other: EvaluationContext | Record<string, unknown>): EvaluationContext {
    const otherCtx = other instanceof EvaluationContext ? other.context : other;
    const otherSecrets =
      other instanceof EvaluationContext ? other.secretValues : new Set<string>();
    const merged = Object.assign(Object.create(null), this._context, otherCtx) as Record<
      string,
      unknown
    >;
    const mergedSecrets = new Set<string>([...this._secretValues, ...otherSecrets]);
    return new EvaluationContext(
      this.source,
      merged,
      this._createInstance,
      mergedSecrets,
      this.emit,
    );
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
}
