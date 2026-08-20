/** A step target, and nothing more: it echoes its inputs so the parent can tell
 *  the value came back from the resource it named. */
import type { ResourceContext, ResourceManifest } from "@telorun/sdk";

export class EchoController {
  constructor(
    private readonly resource: ResourceManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: { text?: string }): Promise<unknown> {
    return { echoed: `${this.resource.prefix ?? ""}${inputs?.text ?? ""}` };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(): void {}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<EchoController> {
  return new EchoController(resource, ctx);
}
