import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

interface WriteStreamResource {
  metadata: { name: string; module?: string };
}

interface WriteStreamInputs {
  input: AsyncIterable<unknown>;
}

/**
 * Drains a `Stream<string | Uint8Array>` to `ctx.stdout`. Strings go through
 * Node's native UTF-8 path; `Uint8Array` chunks pass through unchanged.
 *
 * No newline policy: producers control framing. Pair with an upstream
 * transformer that emits strings (e.g. `RecordStream.ExtractText`) or with
 * any byte-producing codec (`Ndjson.Encoder`, `Sse.Encoder`, `Octet.Encoder`).
 */
class ConsoleWriteStream implements ResourceInstance<WriteStreamInputs, void> {
  constructor(
    private readonly resource: WriteStreamResource,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: WriteStreamInputs): Promise<void> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Console.WriteStream "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    for await (const chunk of input) {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) {
        this.ctx.stdout.write(chunk as any);
        continue;
      }
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Console.WriteStream "${name}": items must be string or Uint8Array; got ${typeof chunk}.`,
      );
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: WriteStreamResource,
  ctx: ResourceContext,
): Promise<ConsoleWriteStream> {
  return new ConsoleWriteStream(resource, ctx);
}
