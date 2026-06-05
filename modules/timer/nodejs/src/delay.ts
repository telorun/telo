import type { ControllerContext, InvokeContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { ERR_INVOKE_CANCELLED, InvokeError } from "@telorun/sdk";

interface DelayResource {
  metadata: { name: string; module?: string };
}

interface DelayInputs {
  duration: string;
  value?: unknown;
}

interface DelayOutputs {
  value: unknown;
}

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

function parseDuration(raw: unknown, name: string): number {
  if (typeof raw !== "string") {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Timer.Delay "${name}": 'duration' must be a string like "250ms", "2s", "1.5m", "1h".`,
    );
  }
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
  if (!match) {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Timer.Delay "${name}": invalid duration ${JSON.stringify(raw)}; use a number with a unit, e.g. "250ms", "2s", "1.5m", "1h".`,
    );
  }
  return parseFloat(match[1]) * UNIT_MS[match[2]];
}

/**
 * Wait a duration, then complete. The wait honors the invocation's cancellation
 * token: if the call is cancelled (client disconnect, deadline) the timer is
 * cleared and the call rejects with ERR_INVOKE_CANCELLED rather than holding the
 * timer — and the work behind it — alive. `value` is echoed through unchanged so
 * the delay composes mid-pipeline.
 */
class TimerDelay implements ResourceInstance<DelayInputs, DelayOutputs> {
  constructor(private readonly resource: DelayResource) {}

  async invoke(inputs: DelayInputs, ctx?: InvokeContext): Promise<DelayOutputs> {
    const name = this.resource.metadata.name;
    const ms = parseDuration(inputs?.duration, name);
    const token = ctx?.cancellation;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe?.();
        resolve();
      }, ms);
      // `onCancelled` fires synchronously if the token is already cancelled, so
      // an already-cancelled call clears the timer and rejects immediately.
      const unsubscribe = token?.onCancelled((reason) => {
        clearTimeout(timer);
        reject(
          new InvokeError(
            ERR_INVOKE_CANCELLED,
            `Timer.Delay "${name}": cancelled while waiting${reason ? ` (${reason})` : ""}.`,
          ),
        );
      });
    });

    return { value: inputs?.value ?? null };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: DelayResource,
  _ctx: ResourceContext,
): Promise<TimerDelay> {
  return new TimerDelay(resource);
}
