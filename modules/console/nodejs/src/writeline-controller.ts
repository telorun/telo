import type {
  ControllerContext,
  DataValidator,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
} from "@telorun/sdk";

export function register(ctx: ControllerContext): void {}

class ConsoleWriteLineResource implements ResourceInstance {
  private inputValidator: DataValidator;

  constructor(
    readonly ctx: ResourceContext,
    readonly manifest: any,
  ) {
    this.inputValidator = ctx.createTypeValidator(manifest.inputType);
  }

  invoke(input: any) {
    this.inputValidator.validate(input);
    const output = this.ctx.expandValue(this.manifest.output, input ?? {});
    process.stdout.write(output);
    process.stdout.write("\n");
    this.ctx.emit("StdOut.LineWritten", { line: output });
    return output;
  }
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ConsoleWriteLineResource> {
  return new ConsoleWriteLineResource(ctx, resource);
}
