import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { isCaptureLog, type CaptureLog, type CapturedMessage } from "./capture-controller.js";
import { addressList, bareAddress } from "./mail-message.js";

interface CaptureReadResource {
  metadata: { name: string; module?: string };
  capture: CaptureLog | KindRef<CaptureLog>;
}

interface CaptureReadInputs {
  to?: string;
}

/** Mail.CaptureRead — the messages a capture recorded, optionally only those
 *  with one address among their `to` recipients. */
class MailCaptureRead
  implements ResourceInstance<CaptureReadInputs, { messages: CapturedMessage[] }>
{
  constructor(
    private readonly resource: CaptureReadResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: CaptureReadInputs): Promise<{ messages: CapturedMessage[] }> {
    const capture = this.ctx.resolveRef(
      this.resource.capture,
      isCaptureLog,
      () => `Mail.CaptureRead "${this.resource.metadata.name}": 'capture'`,
      "Mail.Capture",
    );
    const recorded = capture.messages();
    if (inputs.to === undefined) return { messages: [...recorded] };
    const wanted = inputs.to.trim().toLowerCase();
    return {
      messages: recorded.filter((message) =>
        addressList(message.to).some((to) => bareAddress(to).toLowerCase() === wanted),
      ),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(
  resource: CaptureReadResource,
  ctx: ResourceContext,
): Promise<MailCaptureRead> {
  return new MailCaptureRead(resource, ctx);
}
