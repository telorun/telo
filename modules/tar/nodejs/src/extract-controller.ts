import { Readable } from "node:stream";
import { extract as tarExtract } from "tar-stream";
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

interface ExtractResource {
  metadata: { name: string; module?: string };
}

interface ExtractInputs {
  input: AsyncIterable<unknown>;
  path: string;
}

interface ExtractOutputs {
  output: Stream<Uint8Array>;
}

/**
 * Pull one named entry out of a tar byte stream. The archive is scanned to
 * completion; the matched entry's bytes are buffered (entries selected by name
 * are small — e.g. a manifest) and re-emitted as a single-chunk
 * `Stream<Uint8Array>`. A missing entry raises `ERR_NOT_FOUND`.
 */
class TarExtract implements ResourceInstance<ExtractInputs, ExtractOutputs> {
  constructor(private readonly resource: ExtractResource) {}

  async invoke(inputs: ExtractInputs): Promise<ExtractOutputs> {
    const name = this.resource.metadata.name;
    const input = inputs?.input;
    const path = inputs?.path;
    if (!input || typeof (input as any)[Symbol.asyncIterator] !== "function") {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Tar.Extract "${name}": 'input' must be an AsyncIterable.`,
      );
    }
    if (typeof path !== "string" || path.length === 0) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Tar.Extract "${name}": 'path' must be a non-empty string.`,
      );
    }
    const bytes = await extractEntry(input, path, name);
    return { output: new Stream(once(bytes)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* once(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}

function normalize(p: string): string {
  return p.replace(/^\.\//, "").replace(/^\/+/, "");
}

function extractEntry(
  source: AsyncIterable<unknown>,
  path: string,
  name: string,
): Promise<Uint8Array> {
  const target = normalize(path);
  return new Promise<Uint8Array>((resolve, reject) => {
    const ex = tarExtract();
    const src = Readable.from(toBytes(source, name));
    let found: Uint8Array | null = null;
    let settled = false;
    // Single exit point: `.pipe` doesn't tear down the source when the
    // destination errors, so destroy it on every settle path (matters once a
    // real file/socket sits upstream). On the happy path src has already ended,
    // so this is a no-op.
    const settle = (err: unknown, value?: Uint8Array) => {
      if (settled) return;
      settled = true;
      src.destroy();
      if (err) reject(err);
      else resolve(value!);
    };

    ex.on("entry", (header, stream, next) => {
      if (found === null && normalize(header.name) === target) {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          found = new Uint8Array(Buffer.concat(chunks));
          next();
        });
        stream.on("error", (err) => settle(err));
      } else {
        // Skip unmatched entries — they must be drained for tar-stream to
        // advance to the next header.
        stream.on("end", next);
        stream.on("error", (err) => settle(err));
        stream.resume();
      }
    });

    ex.on("finish", () => {
      if (found === null) {
        settle(
          new InvokeError(
            "ERR_NOT_FOUND",
            `Tar.Extract "${name}": no entry '${path}' in archive.`,
          ),
        );
        return;
      }
      settle(null, found);
    });

    ex.on("error", (err) => settle(err));

    src.on("error", (err) => ex.destroy(err));
    src.pipe(ex);
  });
}

async function* toBytes(
  source: AsyncIterable<unknown>,
  name: string,
): AsyncIterable<Uint8Array> {
  for await (const chunk of source) {
    if (chunk instanceof Uint8Array) {
      yield chunk;
      continue;
    }
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `Tar.Extract "${name}": items must be Uint8Array; got ${typeof chunk}.`,
    );
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: ExtractResource,
  _ctx: ResourceContext,
): Promise<TarExtract> {
  return new TarExtract(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
