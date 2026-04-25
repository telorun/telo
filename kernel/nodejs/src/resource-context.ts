import {
  NoopValidator,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
  RuntimeError,
  RuntimeResource,
  isCompiledValue,
  type ControllerPolicy,
  type EvaluationContext as IEvaluationContext,
  type LoadOptions,
  type ModuleContext,
  type ParsedArgs,
  type TypeRule,
} from "@telorun/sdk";
import AjvModule from "ajv";
import addFormats from "ajv-formats";
import { EvaluationContext } from "./evaluation-context.js";
import { Kernel } from "./kernel.js";
import { formatAjvErrors } from "./manifest-schemas.js";
import { policyFingerprint } from "./runtime-registry.js";
import { SchemaValidator } from "./schema-validator.js";

const Ajv = AjvModule.default ?? AjvModule;

export class ResourceContextImpl implements ResourceContext {
  readonly env: Record<string, string | undefined>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly args: ParsedArgs;

  constructor(
    readonly kernel: Kernel,
    readonly moduleContext: ModuleContext,
    private readonly metadata: Record<string, any>,
    private readonly validator: SchemaValidator = new SchemaValidator(),
    env?: Record<string, string | undefined>,
    stdin?: NodeJS.ReadableStream,
    stdout?: NodeJS.WritableStream,
    stderr?: NodeJS.WritableStream,
    args?: ParsedArgs,
  ) {
    this.env = env ?? process.env;
    this.stdin = stdin ?? process.stdin;
    this.stdout = stdout ?? process.stdout;
    this.stderr = stderr ?? process.stderr;
    this.args = args ?? { _: [] };
  }

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

  registerTypeRules(name: string, rules: TypeRule[]): void {
    this.validator.addTypeRules(name, rules);
  }

  lookupTypeRules(name: string): TypeRule[] | undefined {
    return this.validator.getTypeRules(name);
  }

  createTypeValidator(typeRef: string | Record<string, any> | undefined) {
    if (!typeRef) return new NoopValidator();

    // String ref, or {kind, name} ref object produced by inline-resource
    // normalization (before Phase 5 injection substitutes the live instance).
    // Both resolve by looking up the registered schema by name.
    const hasInlineSchema =
      typeof typeRef !== "string" && typeRef.schema && typeof typeRef.schema === "object";
    const refName =
      typeof typeRef === "string"
        ? typeRef
        : typeof typeRef.name === "string" && !hasInlineSchema
          ? typeRef.name
          : undefined;

    if (refName !== undefined) {
      const schema = this.validator.getSchema(refName);
      if (!schema) {
        throw new RuntimeError(
          "ERR_TYPE_NOT_FOUND",
          `Type "${refName}" not found in schema registry`,
        );
      }
      const base = this.validator.compile(schema);
      const rules = this.validator.getTypeRules(refName);
      if (rules && rules.length > 0) {
        return this.validator.composeWithRules(base, refName, rules);
      }
      return base;
    }

    // Strings were handled above. TS can't follow the narrowing through the
    // compound `refName` expression, so restate it here.
    if (typeof typeRef === "string") return this.validator.compile(typeRef);

    // Inline schema object: if it has a `schema` property, it's a type resource shape
    if (hasInlineSchema) {
      const base = this.validator.compile(typeRef.schema);
      const rules = Array.isArray(typeRef.rules) ? typeRef.rules : [];
      if (rules.length > 0) {
        return this.validator.composeWithRules(base, "inline", rules);
      }
      return base;
    }

    // Raw JSON Schema object (direct schema, not wrapped in type resource)
    return this.validator.compile(typeRef);
  }

  validateSchema(value: any, schema: any) {
    const ajv = new Ajv({
      removeAdditional: true,
    });
    addFormats.default(ajv);
    for (const kw of ["x-telo-ref", "x-telo-scope", "x-telo-context", "x-telo-schema-from"]) {
      ajv.addKeyword(kw);
    }
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

  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
  ): Promise<any> {
    return this.moduleContext.invokeResolved(kind, name, instance, inputs);
  }

  async run(name: string) {
    await this.moduleContext.run(name);
  }

  registerManifest(resource: any): void {
    this.moduleContext.registerManifest(resource);
  }

  loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]> {
    return this.kernel.loadModule(url, options);
  }

  loadManifests(url: string): Promise<ResourceManifest[]> {
    return this.kernel.loadManifests(url);
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

    // Register an inline manifest when:
    //  - the ref carries definition properties (clearly an inline definition), or
    //  - the ref is bare `{kind}` with no explicit name and the caller supplied
    //    a `resourceName` (the slot is known-inline — e.g. a Run.Sequence step
    //    with `invoke: {kind: SomeInvocable}` — and wants a fresh stateless
    //    instance registered under the generated name).
    // Pure references (`{kind, name}` pointing at an existing resource) carry
    // an explicit name and skip registration.
    const hasInlineProperties = Object.keys(resource).some(
      (k) => k !== "kind" && k !== "name" && k !== "metadata",
    );
    const hasExplicitName = resource.name !== undefined || resource.metadata?.name !== undefined;
    const shouldRegister =
      (hasInlineProperties || (!hasExplicitName && resourceName !== undefined)) &&
      !this.moduleContext.hasManifest(name);

    if (shouldRegister) {
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

  getResourcesByName(_kind: string, name: string): RuntimeResource | null {
    const entry = this.moduleContext.resourceInstances.get(name);
    return (entry?.resource ?? null) as RuntimeResource | null;
  }

  async registerController(
    moduleName: string,
    kindName: string,
    controllerInstance: any,
  ): Promise<void> {
    const fingerprint = policyFingerprint(this.moduleContext.getControllerPolicy());
    await this.kernel.registerController(moduleName, kindName, controllerInstance, fingerprint);
  }

  registerDefinition(def: any) {
    this.kernel.registerResourceDefinition(def);
  }

  getControllerPolicy(): ControllerPolicy | undefined {
    return this.moduleContext.getControllerPolicy();
  }

  on(event: string, handler: (payload?: any) => void | Promise<void>): void {
    this.kernel.on(event, handler);
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
    this.moduleContext.registerImport(alias, targetModule, kinds);
  }

  /**
   * Create a child EvaluationContext attached to the current module context.
   * Register resources on the returned context with registerManifest(), then
   * call initializeResources() to initialize them in isolation.
   */
  spawnChildContext(): IEvaluationContext {
    const child = new EvaluationContext(
      this.moduleContext.source,
      this.moduleContext.context,
      this.moduleContext.createInstance,
      this.moduleContext.secretValues,
      this.moduleContext.emit,
    );
    return this.moduleContext.spawnChild(child);
  }

  transientChild(context: Record<string, any>): IEvaluationContext {
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
