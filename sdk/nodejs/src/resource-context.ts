import { ControllerContext } from "./controller-context.js";
import { RuntimeResource } from "./runtime-resource.js";

export interface DataValidator {
  validate(data: any): void;
  isValid(data: any): boolean;
}

export class NoopValidator implements DataValidator {
  isValid() {
    return true;
  }

  validate() {
    // noop
  }
}

export interface ResourceContext extends ControllerContext {
  acquireHold(reason?: string): () => void;
  emitEvent(event: string, payload?: any): Promise<void>;
  invoke(kind: string, name: string, ...args: any[]): Promise<any>;
  getResources(kind: string): RuntimeResource[];
  getResourcesByName(kind: string, name: string): RuntimeResource | null;
  registerManifest(resource: any): void;
  resolveChildren(resource: any, resourceName?: string): { kind: string; name: string };
  validateSchema(value: any, schema: any): void;
  createSchemaValidator(schema: any): DataValidator;
  registerSchema(name: string, schema: object): void;
  lookupSchema(name: string): object | undefined;
  registerController(
    moduleName: string,
    kindName: string,
    controllerInstance: any,
  ): Promise<void>;
  registerDefinition(definition: any): void;
  registerCapability(name: string, schema?: Record<string, any>): void;
  isCapabilityRegistered(name: string): boolean;
  getCapabilitySchema(name: string): Record<string, any> | null | undefined;
  teardownResource(kind: string, name: string): Promise<void>;
}
