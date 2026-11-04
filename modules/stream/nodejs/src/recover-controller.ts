import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream, isCancellationError, isSuspension, toSequenceError } from "@telorun/sdk";
import { requireStream } from "./stream-input.js";

interface RecoverResource {
  metadata: { name: string; module?: string };
  value?: unknown;
  when?: unknown;
}

interface RecoverInputs {
  input?: unknown;
}

interface RecoverOutputs {
  output: Stream<unknown>;
}

/** The failure `value` and `when` read as `error`: a `catch:` branch's, without its step. */
interface CaughtError {
  code: string;
  message: string;
  data: unknown;
  displayMessage: unknown;
}

/**
 * Every value passes through; a failure of the source ends the stream with
 * `value` instead of the failure.
 *
 * A cancellation and a suspension are never absorbed: one belongs to whoever
 * cancelled, the other to the workflow that owns the run, exactly as a step's
 * `catch:` leaves them. Stopping early and releasing reach the source through
 * `for await`, as in every stage.
 */
class StreamRecover implements ResourceInstance<RecoverInputs, RecoverOutputs> {
  constructor(
    private readonly resource: RecoverResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: RecoverInputs): Promise<RecoverOutputs> {
    const input = requireStream(inputs?.input, "Stream.Recover", this.resource.metadata.name);
    return { output: new Stream(this.recover(input)) };
  }

  private async *recover(input: AsyncIterable<unknown>): AsyncIterable<unknown> {
    try {
      for await (const item of input) yield item;
    } catch (err) {
      if (isCancellationError(err) || isSuspension(err)) throw err;
      const error = caughtError(err, this.resource.metadata.name);
      if (!this.recovers(error)) throw err;
      // The failure ends here, so this log is its only server-side report.
      this.ctx.log.error("A stream failed; ended it with its recovery value", undefined, { error: err });
      yield this.ctx.expandValue(this.resource.value, { error });
    }
  }

  private recovers(error: CaughtError): boolean {
    if (this.resource.when === undefined) return true;
    const verdict = this.ctx.expandValue(this.resource.when, { error });
    if (typeof verdict !== "boolean") {
      throw new InvokeError(
        "ERR_INVALID_VALUE",
        `Stream.Recover "${this.resource.metadata.name}": 'when' must evaluate to a boolean; ` +
          `it produced ${verdict === null ? "null" : typeof verdict} for a failure with code ${error.code}.`,
      );
    }
    return verdict;
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function caughtError(err: unknown, name: string): CaughtError {
  const { code, message, data, displayMessage } = toSequenceError(err, name);
  return { code, message, data, displayMessage };
}

export function register(): void {}

export async function create(resource: RecoverResource, ctx: ResourceContext): Promise<StreamRecover> {
  return new StreamRecover(resource, ctx);
}
