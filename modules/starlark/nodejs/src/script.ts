import type {
  ControllerContext,
  DataValidator,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
  RuntimeResource,
} from "@telorun/sdk";
import starlarkWebasm from "starlark-webasm";
const { initialize } = starlarkWebasm;

declare global {
  var run_starlark_code: (code: string, context?: Record<string, any>) => any;
}

type StarlarkScriptResource = RuntimeResource & {
  code?: string;
  inputType?: string | Record<string, any>;
  outputType?: string | Record<string, any>;
};

/**
 * Patch fetch to support file:// URLs for Node.js,
 * where starlark-webasm uses fetch() to load its WASM file.
 */
function patchFetchForFileUrls(): (() => void) | undefined {
  if (typeof (globalThis as any).Bun !== "undefined") return;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url;
    if (url && url.startsWith("file://")) {
      const { readFile } = await import("fs/promises");
      const { fileURLToPath } = await import("url");
      const buffer = await readFile(fileURLToPath(url));
      return new Response(buffer, {
        headers: { "Content-Type": "application/wasm" },
      });
    }
    return originalFetch(input, init);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

let initialized = false;
export async function register(ctx: ControllerContext): Promise<void> {
  if (!initialized) {
    const restoreFetch = patchFetchForFileUrls();
    // Suppress the "run_starlark_code has been added to the javascript globals" message
    const originalLog = console.log;
    console.log = () => {};
    try {
      await initialize();
    } finally {
      console.log = originalLog;
      restoreFetch?.();
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
