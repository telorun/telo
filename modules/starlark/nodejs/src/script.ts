import type {
  ControllerContext,
  DataValidator,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
  RuntimeResource,
} from "@telorun/sdk";
import { initialize } from "starlark-webasm";

declare global {
  var run_starlark_code: (code: string, context?: Record<string, any>) => any;
}

type StarlarkScriptResource = RuntimeResource & {
  code?: string;
  inputType?: string | Record<string, any>;
  outputType?: string | Record<string, any>;
};

let initialized = false;
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
  private code: string;
  private inputValidator: DataValidator;
  private outputValidator: DataValidator;

  constructor(
    readonly ctx: ResourceContext,
    readonly manifest: ResourceManifest,
  ) {
    this.code = manifest.code || "";
    this.inputValidator = ctx.createTypeValidator(manifest.inputType);
    this.outputValidator = ctx.createTypeValidator(manifest.outputType);
  }

  async invoke(input: Record<string, any>): Promise<any> {
    this.inputValidator.validate(input);
    const result = await executeStarlark(this.code, input);
    this.outputValidator.validate(result);
    return result;
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

  return new StarlarkScript(ctx, resource);
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
