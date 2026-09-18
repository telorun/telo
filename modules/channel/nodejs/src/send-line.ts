import {
  InvokeError,
  type ResourceContext,
  type ResourceInstance,
  type TextChannel,
} from "@telorun/sdk";

interface SendLineResource {
  metadata: { name: string };
  channel: unknown;
}

interface SendLineInputs {
  text: string;
}

/** Writes one line. The newline is appended here rather than left to the author:
 *  a forgotten one fails as a read timeout somewhere else entirely, which is the
 *  least diagnosable failure this surface can produce. */
export class SendLine implements ResourceInstance<SendLineInputs, Record<string, never>> {
  constructor(
    private readonly resource: SendLineResource,
    private readonly channel: TextChannel,
  ) {}

  async invoke(inputs: SendLineInputs): Promise<Record<string, never>> {
    try {
      await this.channel.input.write(`${inputs.text}\n`);
    } catch (err) {
      if (err instanceof InvokeError) throw err;
      throw new InvokeError(
        "ERR_CHANNEL_CLOSED",
        `Channel.SendLine "${this.resource.metadata.name}": the program is no longer taking ` +
          `input: ${err instanceof Error ? err.message : String(err)}`,
        { side: "input" },
        { cause: err },
      );
    }
    return {};
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export const schema = { type: "object", additionalProperties: true };

export async function create(
  resource: SendLineResource,
  ctx: ResourceContext,
): Promise<SendLine> {
  const channel = ctx.resolveRef<TextChannel>(
    resource.channel,
    (value): value is TextChannel => typeof (value as TextChannel)?.input?.write === "function",
    () => `Channel.SendLine "${resource.metadata.name}" channel`,
    "Channel.Text",
  );
  return new SendLine(resource, channel);
}
