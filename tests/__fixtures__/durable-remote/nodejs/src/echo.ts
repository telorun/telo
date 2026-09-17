/** A step target, and nothing more: it echoes its inputs so the parent can tell
 *  the value came back from the resource it named.
 *
 *  It echoes a TIMESTAMP and BYTES beside the text, and refuses either arriving
 *  as anything else. Those are the two types a JSON hop silently changes — a
 *  timestamp into a string, bytes into an object keyed by index — so a fixture
 *  echoing only text would have passed just as well with the encoding removed. */
import { InvokeError, type ResourceContext, type ResourceManifest } from "@telorun/sdk";

interface EchoInputs {
  text?: string;
  at?: unknown;
  key?: unknown;
}

export class EchoController {
  constructor(
    private readonly resource: ResourceManifest,
    private readonly ctx: ResourceContext,
  ) {}

  async invoke(inputs: EchoInputs): Promise<unknown> {
    const at = inputs?.at;
    const key = inputs?.key;
    if (!(at instanceof Date) || !(key instanceof Uint8Array)) {
      throw new InvokeError(
        "ERR_REMOTE_INPUT_UNTYPED",
        `The step's inputs crossed the process boundary as ${describe(at)} and ${describe(key)}, ` +
          `not as a timestamp and bytes. The far side would then compute against values of a ` +
          `different type from the ones the step was given.`,
        { at: describe(at), key: describe(key) },
      );
    }
    return {
      echoed: `${this.resource.prefix ?? ""}${inputs?.text ?? ""}`,
      at,
      key,
    };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  const name = Object.getPrototypeOf(value)?.constructor?.name;
  return name ? `a ${name}` : typeof value;
}

export function register(): void {}

export async function create(
  resource: ResourceManifest,
  ctx: ResourceContext,
): Promise<EchoController> {
  return new EchoController(resource, ctx);
}
