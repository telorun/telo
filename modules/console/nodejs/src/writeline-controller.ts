import type {
  ControllerContext,
  ResourceContext,
  ResourceInstance,
  ResourceManifest,
} from "@telorun/sdk";
import { isTtyStream, render } from "./markup.js";

export function register(ctx: ControllerContext): void {}

interface WriteLineInputs {
  output: string;
}

class ConsoleWriteLineResource implements ResourceInstance<WriteLineInputs, string> {
  constructor(readonly ctx: ResourceContext) {}

  async invoke(inputs: WriteLineInputs): Promise<string> {
    const output = String(inputs?.output ?? "");
    const rendered = render(output, isTtyStream(this.ctx.stdout as any));
    this.ctx.stdout.write(rendered);
    this.ctx.stdout.write("\n");
    this.ctx.emit("LineWritten", { line: output });
    return output;
  }
}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<ConsoleWriteLineResource> {
  return new ConsoleWriteLineResource(ctx);
}
