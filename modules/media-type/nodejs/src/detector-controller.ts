import {
  ERR_INPUT_INVALID,
  InvokeError,
  Stream,
  type ResourceContext,
  type ResourceInstance,
} from "@telorun/sdk";
import { openBytes, openStream } from "./leading-bytes.js";
import { detect, WINDOW } from "./media-type-detection.js";

interface DetectorResource {
  metadata: { name: string; module?: string };
}

interface DetectorInputs {
  input: unknown;
  declared?: string | null;
}

interface DetectorOutputs {
  mediaType: string;
  mislabelled: boolean;
  output: Stream<Uint8Array>;
}

/**
 * MediaType.Detector — what a value is, read from its leading bytes, against
 * what it was declared to be. It reports and never refuses: the only failures
 * are a value outside the input contract and a failure of the source itself.
 */
class MediaTypeDetector implements ResourceInstance<DetectorInputs, DetectorOutputs> {
  private readonly describe: string;

  constructor(resource: DetectorResource) {
    this.describe = `MediaType.Detector "${resource.metadata.name}"`;
  }

  async invoke(inputs: DetectorInputs): Promise<DetectorOutputs> {
    const { input } = inputs;
    const declared = typeof inputs.declared === "string" ? inputs.declared : undefined;
    let opened;
    if (input instanceof Uint8Array) {
      opened = openBytes(input, WINDOW);
    } else if (isAsyncIterable(input)) {
      opened = await openStream(input, WINDOW, (value) => this.byteChunk(value));
    } else {
      // A stream is a live value the input contract never inspects, so with a
      // stream branch declared the contract admits any value here; the refusal
      // it would have made is made here, under its code.
      throw this.invalid("input", "must be bytes or a stream of bytes");
    }
    return { ...detect(opened.leading, declared), output: new Stream(opened.content) };
  }

  private byteChunk(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    throw this.invalid(
      "input",
      `is a stream that yielded ${value === null ? "null" : typeof value} — expected bytes`,
    );
  }

  private invalid(path: string, problem: string): InvokeError {
    const message = `${this.describe}: '${path}' ${problem}.`;
    return new InvokeError(ERR_INPUT_INVALID, message, { issues: [{ path, message }] });
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  );
}

export async function create(
  resource: DetectorResource,
  ctx: ResourceContext,
): Promise<MediaTypeDetector> {
  return new MediaTypeDetector(resource);
}
