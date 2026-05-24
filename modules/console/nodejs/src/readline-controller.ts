import type { ResourceContext, ResourceInstance, RuntimeResource } from "@telorun/sdk";
import * as rl from "readline";
import { isTtyStream, render } from "./markup.js";

interface ReadLineInputs {
  prompt: string;
}

class ConsoleReadLine implements ResourceInstance<ReadLineInputs, { value: string }> {
  constructor(private readonly ctx: ResourceContext) {}

  async invoke(inputs: ReadLineInputs): Promise<{ value: string }> {
    const iface = rl.createInterface({
      input: this.ctx.stdin,
      output: this.ctx.stdout,
    });
    const prompt = render(String(inputs?.prompt ?? ""), isTtyStream(this.ctx.stdout as any));
    const value = await new Promise<string>((resolve) => {
      iface.question(prompt, (answer) => {
        iface.close();
        resolve(answer);
      });
    });
    return { value };
  }
}

export function register(): void {}

export async function create(
  resource: RuntimeResource,
  ctx: ResourceContext,
): Promise<ConsoleReadLine> {
  return new ConsoleReadLine(ctx);
}
