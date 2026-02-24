import { NoopValidator, ResourceContext, RuntimeResource } from "@telorun/sdk";
import AjvModule from "ajv";
import { expandValue } from "./expressions.js";
import { Kernel } from "./kernel.js";
import { formatAjvErrors } from "./manifest-schemas.js";
import { SchemaValidator } from "./schema-valiator.js";
import { RuntimeError } from "./types.js";
const Ajv = AjvModule.default ?? AjvModule;

export class ResourceContextImpl implements ResourceContext {
  constructor(
    readonly kernel: Kernel,
    private readonly metadata: Record<string, any>,
    private readonly validator: SchemaValidator = new SchemaValidator(),
    private readonly resourceKey?: string,
  ) {}

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
        `Invalid value passed: ${JSON.stringify(value)}. Error: ${formatAjvErrors(validate.errors)}`,
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
    resourceKind: string,
    controllerInstance: any,
  ): Promise<void> {
    await this.kernel.registerController(moduleName, resourceKind, controllerInstance);
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
    await this.kernel.emitRuntimeEvent(event, payload);
  }

  acquireHold(reason?: string): () => void {
    return this.kernel.acquireHold(reason);
  }

  requestExit(code: number): void {
    this.kernel.requestExit(code);
  }

  evaluateCel(expression: string, context: Record<string, any>): unknown {
    throw new Error("Method evaluateCel not implemented.");
  }

  expandValue(value: any, context: Record<string, any>) {
    return expandValue(value, context);
  }

  async emitEvent(event: string, payload?: any) {
    await this.kernel.emitRuntimeEvent(event, payload);
  }
}
