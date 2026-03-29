import {
  EvaluationContext,
  ModuleContext,
  NoopValidator,
  ResourceContext,
  RuntimeError,
  RuntimeResource,
  isCompiledValue,
} from "@telorun/sdk";
import AjvModule from "ajv";
import addFormats from "ajv-formats";
import { Kernel } from "./kernel.js";
import { formatAjvErrors } from "./manifest-schemas.js";
import { SchemaValidator } from "./schema-valiator.js";

const Ajv = AjvModule.default ?? AjvModule;

export class ResourceContextImpl implements ResourceContext {
  constructor(
    readonly kernel: Kernel,
    readonly moduleContext: ModuleContext,
    private readonly metadata: Record<string, any>,
    private readonly validator: SchemaValidator = new SchemaValidator(),
  ) {}

  stdin: NodeJS.ReadableStream = process.stdin;
  stdout: NodeJS.WritableStream = process.stdout;
  stderr: NodeJS.WritableStream = process.stderr;

  createSchemaValidator(schema: any) {
    if (!schema) {
      return new NoopValidator();
    }
    return this.validator.compile(schema);
  }

  registerSchema(name: string, schema: object): void {
    this.validator.addSchema(name, schema);
  }

  lookupSchema(name: string): object | undefined {
    return this.validator.getSchema(name);
  }

  validateSchema(value: any, schema: any) {
    const ajv = new Ajv({
      removeAdditional: true,
    });
    addFormats.default(ajv);
    const validate = ajv.compile(
      "type" in schema && typeof schema.type === "string"
        ? schema
        : {
            type: "object",
            properties: schema,
            required: Object.keys(schema),
            additionalProperties: false,
          },
    );
    const isValid = validate(stripCompiledValues(value));
    if (!isValid) {
      throw new RuntimeError(
        "ERR_INVALID_VALUE",
        `[${this.metadata.name}] Invalid value. Error: ${formatAjvErrors(validate.errors)}`,
      );
    }
  }

  invoke<TInputs>(kind: string, name: string, inputs: TInputs): Promise<any> {
    return this.moduleContext.invoke(kind, name, inputs);
  }

  async run(name: string) {
    await this.moduleContext.run(name);
  }

  registerManifest(resource: any): void {
    this.moduleContext.registerManifest(resource);
  }

  /**
   * Resolves a resource into a normalized {kind, name} reference.
   * If the resource contains a definition (kind + properties), registers it as a manifest.
   * Returns the normalized reference in all cases.
   *
   * @param resource Resource definition or reference object with 'kind' property
   * @param resourceName Optional name to assign if not present in resource
   * @returns Normalized {kind, name} reference
   * @throws RuntimeError if 'kind' is missing
   */
  resolveChildren(resource: any, resourceName?: string): { kind: string; name: string } {
    if (!resource || typeof resource !== "object") {
      throw new RuntimeError(
        "ERR_INVALID_VALUE",
        `[${this.metadata.name}] Resource must be an object. Got: ${typeof resource}`,
      );
    }

    if (!resource.kind) {
      throw new RuntimeError(
        "ERR_INVALID_VALUE",
        `[${this.metadata.name}] Resource must have 'kind' property. Got: ${JSON.stringify(resource)}`,
      );
    }

    const kind = resource.kind;
    const name =
      resource.name ??
      resource.metadata?.name ??
      resourceName ??
      `Unnamed${Math.random().toString(16).slice(2, 8)}`;

    // If resource has properties beyond kind/name, it's a definition - register it
    const definitionKeys = Object.keys(resource).filter(
      (k) => k !== "kind" && k !== "name" && k !== "metadata",
    );

    if (definitionKeys.length > 0 && !this.moduleContext.hasManifest(name)) {
      this.registerManifest({
        ...resource,
        metadata: {
          name,
          module: this.metadata.module,
          ...resource.metadata,
        },
      });
    }

    return { kind, name };
  }

  teardownResource(kind: string, name: string): Promise<void> {
    throw new Error("Method teardownResource not implemented.");
    // const parts = kind.split(".");
    // if (parts.length > 2) {
    //   return this.kernel.teardownResource(parts[0], parts.slice(1).join("."), name);
    // }
    // return this.kernel.teardownResource(this.metadata.module, kind, name);
  }

  getResources(kind: string): RuntimeResource[] {
    throw new Error("Method teardownResource not implemented.");
    // return this.kernel.getResourcesByKind(kind);
  }

  getResourcesByName(_kind: string, name: string): RuntimeResource | null {
    const entry = this.moduleContext.resourceInstances.get(name);
    return (entry?.resource ?? null) as RuntimeResource | null;
  }

  async registerController(
    moduleName: string,
    kindName: string,
    controllerInstance: any,
  ): Promise<void> {
    await this.kernel.registerController(moduleName, kindName, controllerInstance);
  }

  registerDefinition(def: any) {
    this.kernel.registerResourceDefinition(def);
  }

  on(event: string, handler: (payload?: any) => void | Promise<void>): void {
    this.kernel.on(event, handler);
  }

  once(event: string, handler: (payload?: any) => void | Promise<void>): void {
    throw new Error("Method once not implemented.");
  }

  off(event: string, handler: (payload?: any) => void | Promise<void>): void {
    throw new Error("Method off not implemented.");
  }

  async emit(event: string, payload?: any) {
    await this.kernel.emitRuntimeEvent(`${this.metadata.name}.${event}`, payload);
  }

  acquireHold(reason?: string): () => void {
    return this.kernel.acquireHold(reason);
  }

  requestExit(code: number): void {
    this.kernel.requestExit(code);
  }

  expandValue(value: any, context: Record<string, any>) {
    return this.moduleContext.expandWith(value, context);
  }

  async emitEvent(event: string, payload?: any) {
    await this.kernel.emitRuntimeEvent(event, payload);
  }

  registerModuleImport(alias: string, targetModule: string, kinds: string[]): void {
    const declaringModule = (this.metadata as any).module as string | undefined;
    this.kernel.registerModuleImport(declaringModule ?? "", alias, targetModule, kinds);
  }

  resolveModuleAlias(declaringModule: string, alias: string): string | undefined {
    return this.kernel.resolveModuleAlias(declaringModule, alias);
  }

  getModuleContext(moduleName: string): ModuleContext {
    return this.kernel.getModuleContext(moduleName);
  }

  /**
   * Create a child EvaluationContext attached to the current module context.
   * Queue resources on the returned context with pendingResources.push(), then
   * call initializeChildContext() to initialize them in isolation.
   */
  spawnChildContext(): EvaluationContext {
    const child = new EvaluationContext(
      this.moduleContext.source,
      this.moduleContext.context,
      this.moduleContext.createInstance,
      this.moduleContext.secretValues,
      this.moduleContext.emit,
    );
    return this.moduleContext.spawnChild(child);
  }

  transientChild(context: Record<string, any>): EvaluationContext {
    return this.moduleContext.transientChild(context);
  }

  /**
   * Create a temporary child context, queue manifests on it, run a function,
   * then tear down the child context and its resources.
   * Note: This always returns a Promise even though the interface signature
   * suggests T. The callback can be sync or async (passed as async function).
   */
  withManifests<T>(manifests: any[], fn: () => T): T {
    const child = this.spawnChildContext();
    // Return a Promise cast as T - callers will use await
    return (async () => {
      try {
        for (const manifest of manifests || []) {
          if (manifest) {
            child.registerManifest(manifest);
          }
        }
        await child.initializeResources();
        return await Promise.resolve(fn() as any);
      } finally {
        await child.teardownResources();
      }
    })() as unknown as T;
  }
}

function stripCompiledValues(v: unknown): unknown {
  if (isCompiledValue(v)) return "";
  if (Array.isArray(v)) return v.map(stripCompiledValues);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = stripCompiledValues(val);
    }
    return out;
  }
  return v;
}
