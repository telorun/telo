import type {
    ControllerContext,
    ResourceContext,
    ResourceInstance,
    ResourceManifest,
    RuntimeResource,
} from "@telorun/sdk";
import Ajv, { ErrorObject, ValidateFunction } from "ajv";
import { initialize } from "starlark-webasm";

declare global {
  var run_starlark_code: (code: string, context?: Record<string, any>) => any;
}

type StarlarkScriptResource = RuntimeResource & {
  code?: string;
  inputSchema?: Record<string, any>;
  outputSchema?: Record<string, any>;
};

let initialized = false;
const ajv = new Ajv({ allErrors: true, strict: false });
const inputValidators = new Map<string, ValidateFunction>();
const outputValidators = new Map<string, ValidateFunction>();

export async function register(ctx: ControllerContext): Promise<void> {
  if (!initialized) {
    // Suppress the "run_starlark_code has been added to the javascript globals" message
    const originalLog = console.log;
    console.log = () => {};
    try {
      await initialize();
    } finally {
      console.log = originalLog;
    }
    initialized = true;
  }
}

class StarlarkScript implements ResourceInstance {
  private name: string;
  private code: string;

  constructor(
    readonly ctx: ResourceContext,
    readonly manifest: ResourceManifest,
  ) {
    this.name = manifest.metadata.name;
    this.code = manifest.code || "";
  }

  async init(): Promise<void> {
    // Starlark code is compiled on-demand during execution
  }

  async invoke(input: Record<string, any>): Promise<any> {
    this.ctx.validateSchema(input, this.manifest.inputSchema);
    const result = await executeStarlark(this.code, input);
    this.ctx.validateSchema(result, this.manifest.outputSchema);
    return result;
  }

  async teardown(): Promise<void> {
    inputValidators.delete(`${this.name}:input`);
    outputValidators.delete(`${this.name}:output`);
  }
}

export async function create(
  resource: StarlarkScriptResource,
  ctx: ResourceContext,
): Promise<ResourceInstance> {
  const name = resource.metadata.name;
  if (!resource.code) {
    throw new Error(`StarlarkScript "${name}" is missing code`);
  }

  const instance = new StarlarkScript(ctx, resource);
  await instance.init();
  return instance;
}

async function executeStarlark(code: string, input: any): Promise<any> {
  try {
    const result = globalThis.run_starlark_code(
      `${code}\ndef main():\n  print(str(run(${JSON.stringify(input)})))`,
    );
    if (result.error) {
      throw new Error(result.error);
    }

    let cleanJson = result.message
      .replace(/'/g, '"')
      .replace(/True/g, "true")
      .replace(/False/g, "false")
      .replace(/None/g, "null");
    const trimmed = cleanJson.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        throw new Error("Invalid output from Starlark code");
      }
    }

    return cleanJson;
  } catch (error) {
    throw new Error(
      `StarlarkScript execution failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getValidator(
  cache: Map<string, ValidateFunction>,
  key: string,
  schema: Record<string, any>,
): ValidateFunction {
  const existing = cache.get(key);
  if (existing) {
    return existing;
  }
  const compiled = ajv.compile(schema);
  cache.set(key, compiled);
  return compiled;
}

function formatAjvErrors(errors?: ErrorObject[] | null): string {
  if (!errors || errors.length === 0) {
    return "Validation failed";
  }
  return errors
    .map((err) => {
      const path = err.instancePath && err.instancePath.length > 0 ? err.instancePath : "/";
      const message = err.message || "is invalid";
      return `${path} ${message}`;
    })
    .join("; ");
}
