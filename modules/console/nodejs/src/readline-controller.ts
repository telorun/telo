import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import * as rl from "readline";
import { isTtyStream, render } from "./markup.js";

type ConsoleReadLineResource = RuntimeResource & {
  prompt: string;
};

class ConsoleReadLine implements ResourceInstance {
  private value: string = "";

  constructor(
    private readonly resource: ConsoleReadLineResource,
    private readonly ctx: ResourceContext,
  ) {}

  snapshot(): { value: string } {
    return { value: this.value };
  }

  async invoke(): Promise<{ value: string }> {
    const iface = rl.createInterface({
      input: this.ctx.stdin,
      output: this.ctx.stdout,
    });
    const prompt = render(this.resource.prompt, isTtyStream(this.ctx.stdout as any));
    this.value = await new Promise<string>((resolve) => {
      iface.question(prompt, (answer) => {
        iface.close();
        resolve(answer);
      });
    });
    return { value: this.value };
  }
}

export function register(): void {}

export async function create(
  resource: ConsoleReadLineResource,
  ctx: ResourceContext,
): Promise<ConsoleReadLine> {
  return new ConsoleReadLine(resource, ctx);
}
