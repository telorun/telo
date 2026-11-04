import type { KindRef, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { isCaptureLog, type CaptureLog, type CapturedMessage } from "./capture-controller.js";

interface CaptureReadResource {
  metadata: { name: string; module?: string };
  capture: CaptureLog | KindRef<CaptureLog>;
}

interface CaptureReadInputs {
  to?: string;
}

/** Sms.CaptureRead — the messages a capture recorded, optionally only those
 *  sent to one number. */
class SmsCaptureRead
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
      () => `Sms.CaptureRead "${this.resource.metadata.name}": 'capture'`,
      "Sms.Capture",
    );
    const recorded = capture.messages();
    return {
      messages:
        inputs.to === undefined
          ? [...recorded]
          : recorded.filter((message) => message.to === inputs.to),
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export async function create(
  resource: CaptureReadResource,
  ctx: ResourceContext,
): Promise<SmsCaptureRead> {
  return new SmsCaptureRead(resource, ctx);
}
