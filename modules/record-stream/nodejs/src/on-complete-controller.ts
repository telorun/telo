import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

/**
 * RecordStream.OnComplete — a stream passthrough that fires a side effect once the
 * input has been fully consumed. Every item forwards to `output` in order as it
 * arrives (the downstream consumer streams live); the items are also retained, and
 * when the input completes normally the injected `handler` Invocable is called once
 * with `{ records, context }` — `records` is the full list observed, `context` is the
 * opaque caller data passed through the `context` input.
 *
 * The canonical use is persist-while-streaming: an HTTP handler streams an AI/agent
 * response to the client via `output` and, at end-of-stream, `handler` writes the turn
 * to a store. The primitive stays domain-neutral — it does no CEL and knows nothing of
 * SQL; the projection from `records` to whatever the store needs lives in `handler`
 * (typically a Run.Sequence).
 *
 * `handler` is NOT called if the input errors (a thrown iterator error propagates) or
 * the consumer cancels early (`break` / aborted response) — completion means the input
 * ran to its end. Records are buffered in memory, bounded by the input stream's length
 * (same envelope as RecordStream.Tee).
 */
interface OnCompleteResource {
  metadata: { name: string; module?: string };
  /** Live Invocable instance after Phase 5 ref injection. */
  handler: { invoke(inputs: unknown): Promise<unknown> };
}

interface OnCompleteInputs {
  input: AsyncIterable<unknown>;
  context?: unknown;
}

interface OnCompleteOutputs {
  output: Stream<unknown>;
}

class OnComplete implements ResourceInstance<OnCompleteInputs, OnCompleteOutputs> {
  constructor(private readonly resource: OnCompleteResource) {}

  async invoke(inputs: OnCompleteInputs): Promise<OnCompleteOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `RecordStream.OnComplete "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    const handler = this.resource.handler;
    if (!handler || typeof handler.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `RecordStream.OnComplete "${name}": 'handler' is not a live Invocable instance — check that Phase 5 injection ran.`,
      );
    }
    const context = inputs.context;

    async function* passthrough(): AsyncGenerator<unknown> {
      const records: unknown[] = [];
      for await (const item of input) {
        records.push(item);
        yield item;
      }
      // Input ran to its end — fire the completion handler once, then close. An error
      // from the handler propagates (the stream ends by throwing); it is not swallowed.
      await handler.invoke({ records, context });
    }

    return { output: new Stream(passthrough()) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: OnCompleteResource,
  _ctx: ResourceContext,
): Promise<OnComplete> {
  return new OnComplete(resource);
}
