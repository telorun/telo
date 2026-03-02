import { NoopValidator, ResourceContext, RuntimeResource } from "@telorun/sdk";
import AjvModule from "ajv";
import { EvaluationContext, ModuleContext } from "./evaluation-context.js";
import { Kernel } from "./kernel.js";
import { formatAjvErrors } from "./manifest-schemas.js";
import { SchemaValidator } from "./schema-valiator.js";
import { RuntimeError } from "./types.js";

const Ajv = AjvModule.default ?? AjvModule;

export class ResourceContextImpl implements ResourceContext {
  constructor(
    readonly kernel: Kernel,
    private readonly moduleContext: ModuleContext,
    private readonly metadata: Record<string, any>,
    private readonly validator: SchemaValidator = new SchemaValidator(),
    private readonly resourceKey?: string,
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
    const ajv = new Ajv();
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
    const isValid = validate(value);
    if (!isValid) {
      throw new RuntimeError(
        "ERR_INVALID_VALUE",
        `[${this.metadata.name}] Invalid value passed: ${JSON.stringify(value)}. Error: ${formatAjvErrors(validate.errors)}`,
      );
    }
  }

  invoke(kind: string, name: string, ...args: any[]): Promise<any> {
    const parts = kind.split(".");
    if (parts.length > 2) {
      return this.kernel.invoke(parts[0], parts.slice(1).join("."), name, ...args);
    }
    return this.kernel.invoke(this.metadata.module, kind, name, ...args);
  }

  registerManifest(resource: any): void {
    if (this.resourceKey) {
      this.kernel.registerChildManifest(this.resourceKey, resource);
    } else {
      this.kernel.registerManifest(resource);
    }
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
    const name = resource.name ?? resourceName ?? "Unnamed";

    // If resource has properties beyond kind/name, it's a definition - register it
    const definitionKeys = Object.keys(resource).filter(
      (k) => k !== "kind" && k !== "name" && k !== "metadata",
    );

    if (definitionKeys.length > 0) {
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
    const parts = kind.split(".");
    if (parts.length > 2) {
      return this.kernel.teardownResource(parts[0], parts.slice(1).join("."), name);
    }
    return this.kernel.teardownResource(this.metadata.module, kind, name);
  }

  getResources(kind: string): RuntimeResource[] {
    return this.kernel.getResourcesByKind(kind);
  }

  getResourcesByName(kind: string, name: string): RuntimeResource | null {
    return this.kernel.getResourceByName(this.metadata.module, kind, name);
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

  registerCapability(name: string, schema?: Record<string, any>): void {
    this.kernel.registerCapability(name, schema);
  }

  isCapabilityRegistered(name: string): boolean {
    return this.kernel.isCapabilityRegistered(name);
  }

  getCapabilitySchema(name: string): Record<string, any> | null | undefined {
    return this.kernel.getCapabilitySchema(name);
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

  evaluateCel(expression: string, context: Record<string, any>): unknown {
    return new EvaluationContext(context).evaluate(expression);
  }

  expandValue(value: any, context: Record<string, any>) {
    return this.moduleContext.merge(context).expand(value);
  }

  async emitEvent(event: string, payload?: any) {
    await this.kernel.emitRuntimeEvent(event, payload);
  }

  getModuleContext(moduleName: string): ModuleContext {
    return this.kernel.getModuleContext(moduleName);
  }

  registerModuleImport(
    declaringModule: string,
    alias: string,
    exports: Record<string, unknown>,
  ): void {
    this.kernel.registerModuleImportInContext(declaringModule, alias, exports);
  }

  registerModuleContext(
    moduleName: string,
    variables: Record<string, unknown>,
    secrets: Record<string, unknown>,
  ): void {
    this.kernel.registerModuleContext(moduleName, variables, secrets);
  }
}
