import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";
import { requireStream } from "./stream-input.js";

interface ScanResource {
  metadata: { name: string; module?: string };
  initial?: unknown;
  accumulate?: unknown;
  emit?: unknown;
}

interface ScanInputs {
  input?: unknown;
}

interface ScanOutputs {
  output: Stream<unknown>;
}

/**
 * A fold that emits as it goes — the stage a streaming protocol needs and a
 * terminal fold cannot serve.
 *
 * Reassembling a token stream is the case: each delta is meaningless alone, the
 * accumulated text is what a consumer wants, and it must arrive per token
 * rather than at the end. `Collection.Fold` answers the same question with one
 * value at the finish, which for a stream means never.
 *
 * `emit` is separate from `accumulate` because the state and the thing worth
 * publishing are routinely different — a parser accumulates a buffer and emits
 * only the frames it completed. Omitted, the accumulator itself is emitted,
 * which is the running-total shape.
 */
class StreamScan implements ResourceInstance<ScanInputs, ScanOutputs> {
  constructor(
    private readonly resource: ScanResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: ScanInputs): Promise<ScanOutputs> {
    const name = this.resource.metadata.name;
    const input = requireStream(inputs?.input, "Stream.Scan", name);
    if (this.resource.accumulate === undefined) {
      throw new InvokeError(
        "ERR_INVALID_VALUE",
        `Stream.Scan "${name}": 'accumulate' was written blank. A key with no value ` +
          `parses to null, which the schema cannot tell from a CEL node.`,
      );
    }
    return { output: new Stream(scan(input, this.resource, this.ctx, inputs)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* scan(
  input: AsyncIterable<unknown>,
  resource: ScanResource,
  ctx: ResourceContext,
  call: ScanInputs,
): AsyncIterable<unknown> {
  let acc = ctx.expandValue(resource.initial, { inputs: call });
  let index = 0;
  for await (const item of input) {
    const scope = { inputs: call, acc, item, index };
    acc = ctx.expandValue(resource.accumulate, scope);
    // Evaluated against the NEW accumulator, which is what makes `emit` a
    // statement about the state this element produced rather than the one it
    // replaced.
    yield resource.emit === undefined
      ? acc
      : ctx.expandValue(resource.emit, { inputs: call, acc, item, index });
    index++;
  }
}

export function register(): void {}

export async function create(
  resource: ScanResource,
  ctx: ResourceContext,
): Promise<StreamScan> {
  return new StreamScan(resource, ctx);
}
