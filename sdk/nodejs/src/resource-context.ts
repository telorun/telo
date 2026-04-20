import { ControllerContext } from "./controller-context.js";
import { EvaluationContext } from "./evaluation-context.js";
import { ModuleContext } from "./module-context.js";
import { ResourceInstance } from "./resource-instance.js";
import { ResourceManifest } from "./resource-manifest.js";
import { RuntimeResource } from "./runtime-resource.js";

export interface LoadOptions {
  /** When true, `${{ }}` templates are replaced with CompiledValue wrappers
   *  so they can be evaluated at runtime. Leave unset for static analysis. */
  compile?: boolean;
}

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
  invokeResolved<TInputs>(
    kind: string,
    name: string,
    instance: ResourceInstance,
    inputs: TInputs,
  ): Promise<any>;
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
  /** Load a single module (its own file + `include`d partials). Use this when
   *  you need just the declaring file's manifests. */
  loadModule(url: string, options?: LoadOptions): Promise<ResourceManifest[]>;
  /** Load a module and follow its Telo.Import chain, returning the union of
   *  the module's manifests plus all transitively-imported Telo.Definition
   *  manifests. Use this when you need the full kind surface area visible from
   *  the module. */
  loadManifests(url: string): Promise<ResourceManifest[]>;
  readonly moduleContext: ModuleContext;
  readonly env: Record<string, string | undefined>;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}
