import type {
  ControllerContext,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
} from "@telorun/sdk";

export function register(ctx: ControllerContext): void {}

class ConsoleWriteLineResource implements ResourceInstance {
  constructor(
    readonly ctx: ResourceContext,
    readonly manifest: any,
  ) {}

  invoke(input: any) {
    if (this.manifest.inputSchema) {
      this.ctx.validateSchema(input, this.manifest.inputSchema);
    }
    process.stdout.write(this.ctx.expandValue(this.manifest.output, input ?? {}));
    process.stdout.write("\n");
  }
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ConsoleWriteLineResource> {
  return new ConsoleWriteLineResource(ctx, resource);
}
