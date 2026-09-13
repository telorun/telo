import type {
  ControllerContext,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
} from "@telorun/sdk";

export function register(ctx: ControllerContext): void {}

interface WriteInputs {
  output: string | Uint8Array;
}

/**
 * Writes `output` to stdout as given: no markup rendering, no trailing newline.
 * The bound contract admits only a string or a Uint8Array.
 */
class ConsoleWriteResource implements ResourceInstance<WriteInputs, string | Uint8Array> {
  constructor(readonly ctx: ResourceContext) {}

  async invoke(inputs: WriteInputs): Promise<string | Uint8Array> {
    this.ctx.stdout.write(inputs.output);
    return inputs.output;
  }
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ConsoleWriteResource> {
  return new ConsoleWriteResource(ctx);
}
