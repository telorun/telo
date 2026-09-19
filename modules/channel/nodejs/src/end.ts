import type { ResourceContext, ResourceInstance, TextChannel } from "@telorun/sdk";

interface EndResource {
  metadata: { name: string };
  channel: unknown;
}

/** Closes the input side, so the program reads end of input and may finish on
 *  its own — which is what makes "it exits 0 once its input ends" assertable
 *  without tearing the program down and overwriting its exit code. */
export class End implements ResourceInstance<Record<string, never>, Record<string, never>> {
  constructor(private readonly channel: TextChannel) {}

  async invoke(): Promise<Record<string, never>> {
    await this.channel.input.end();
    return {};
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const schema = { type: "object", additionalProperties: true };

export async function create(resource: EndResource, ctx: ResourceContext): Promise<End> {
  const channel = ctx.resolveRef<TextChannel>(
    resource.channel,
    (value): value is TextChannel => typeof (value as TextChannel)?.input?.end === "function",
    () => `Channel.End "${resource.metadata.name}" channel`,
    "Channel.Text",
  );
  return new End(channel);
}
