import { pack as tarPack } from "tar-stream";
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError, Stream } from "@telorun/sdk";

interface PackResource {
  metadata: { name: string; module?: string };
}

interface PackEntry {
  path: string;
  contents: string;
}

interface PackInputs {
  entries: PackEntry[];
}

interface PackOutputs {
  output: Stream<Uint8Array>;
}

/**
 * Build a tar archive from an ordered list of `{ path, contents }` entries and
 * emit it as a `Stream<Uint8Array>`. Counterpart to `Tar.Extract`. Contents are
 * UTF-8 text (entries packed this way are small — manifests, configs); pipe the
 * output through `Gzip.Encoder` for a `.tar.gz`.
 */
class TarPackResource implements ResourceInstance<PackInputs, PackOutputs> {
  constructor(private readonly resource: PackResource) {}

  async invoke(inputs: PackInputs): Promise<PackOutputs> {
    const name = this.resource.metadata.name;
    const entries = inputs?.entries;
    if (!Array.isArray(entries)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Tar.Pack "${name}": 'entries' must be an array.`,
      );
    }
    for (const e of entries) {
      if (!e || typeof e.path !== "string" || typeof e.contents !== "string") {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Tar.Pack "${name}": each entry needs a string 'path' and string 'contents'.`,
        );
      }
    }
    return { output: new Stream(packStream(entries)) };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

async function* packStream(entries: PackEntry[]): AsyncIterable<Uint8Array> {
  const pack = tarPack();
  // Drive the writer concurrently with the reader: each entry write awaits its
  // callback (backpressure), then the pack is finalized. A write failure
  // destroys the pack, which surfaces as an error on the consuming for-await.
  const writer = (async () => {
    try {
      for (const e of entries) {
        const data = Buffer.from(e.contents, "utf8");
        await new Promise<void>((resolve, reject) => {
          pack.entry({ name: e.path }, data, (err) => (err ? reject(err) : resolve()));
        });
      }
      pack.finalize();
    } catch (err) {
      pack.destroy(err as Error);
    }
  })();

  try {
    for await (const chunk of pack) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as Buffer);
    }
  } finally {
    await writer;
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: PackResource,
  _ctx: ResourceContext,
): Promise<TarPackResource> {
  return new TarPackResource(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
