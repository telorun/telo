import { ControllerContext } from "./controller-context.js";
import { EvaluationContext } from "./evaluation-context.js";
import { ModuleContext } from "./module-context.js";
import { RuntimeResource } from "./runtime-resource.js";

export interface DataValidator {
  validate(data: any): void;
  isValid(data: any): boolean;
}

export interface TypeRule {
  condition: string;
  code: string;
  message?: string;
}

export class NoopValidator implements DataValidator {
  isValid() {
    return true;
  }

  validate() {
    // noop
  }
}

export type ParsedArgs = Partial<Record<string, string | boolean | string[]>> & { _: string[] };

export interface ResourceContext extends ControllerContext {
  readonly args: ParsedArgs;
  acquireHold(reason?: string): () => void;
  emitEvent(event: string, payload?: any): Promise<void>;
  invoke<TInputs>(kind: string, name: string, inputs: TInputs, options?: any): Promise<any>;
  run(kind: string, name: string): Promise<void>;
  getResources(kind: string): RuntimeResource[];
  getResourcesByName(kind: string, name: string): RuntimeResource | null;
  registerManifest(resource: any): void;
  spawnChildContext(): EvaluationContext;
  transientChild(context: Record<string, any>): EvaluationContext;
  withManifests<T>(manifests: any[], fn: () => T): T;
  resolveChildren(resource: any, resourceName?: string): { kind: string; name: string };
  validateSchema(value: any, schema: any): void;
  createSchemaValidator(schema: any): DataValidator;
  registerSchema(name: string, schema: object): void;
  lookupSchema(name: string): object | undefined;
  registerTypeRules(name: string, rules: TypeRule[]): void;
  lookupTypeRules(name: string): TypeRule[] | undefined;
  /** Resolve a type reference (name string or inline schema) to a DataValidator. */
  createTypeValidator(typeRef: string | Record<string, any> | undefined): DataValidator;
  registerController(moduleName: string, kindName: string, controllerInstance: any): Promise<void>;
  registerDefinition(definition: any): void;
  registerModuleImport(alias: string, targetModule: string, kinds: string[]): void;
  teardownResource(kind: string, name: string): Promise<void>;
  readonly moduleContext: ModuleContext;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}
