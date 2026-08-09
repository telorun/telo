import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type {
  AiImageModelInstance,
  GeneratedImage,
  ImageGenerationResult,
  ImageInvokeInput,
} from "./types.js";

/**
 * Internal Ai.ImageModel test fixture — the image counterpart of ai-echo-controller.
 *
 * It produces deterministic bytes derived from the request, so tests can assert what
 * reached the provider (prompt, intent, reference count, merged options) without a
 * live model or a real encoder. The bytes are NOT a valid image; nothing in the
 * contract decodes them, and a fixture that pretended otherwise would need an image
 * library to stay honest.
 *
 * `refuseOn` exercises the refusal path: when the prompt matches, the run reports
 * `content-filter` and yields only `keep` images — which is how a test tells partial
 * refusal (short array) from total refusal (empty array).
 */

interface RefuseOn {
  prompt: string;
  keep?: number;
}

interface EchoImageResource {
  metadata: { name: string; module?: string };
  mediaType?: string;
  count?: number;
  width?: number;
  height?: number;
  refuseOn?: RefuseOn;
  reportUsage?: boolean;
}

/** Intents this fixture serves. Kept narrower than a real provider's on purpose:
 *  the manifest declares the same set as `$defs/Intent`, so a manifest naming an
 *  intent outside it is a static error, and this check is only the backstop. */
const SUPPORTED_INTENTS = new Set(["edit", "inpaint"]);

class EchoImageModel implements ResourceInstance, AiImageModelInstance {
  constructor(private readonly resource: EchoImageResource) {}

  async invoke(input: ImageInvokeInput): Promise<ImageGenerationResult> {
    const name = this.resource.metadata.name;
    const intent = input.intent;
    if (intent !== undefined && !SUPPORTED_INTENTS.has(intent)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `EchoImageModel "${name}": unsupported intent '${intent}' (serves: ${[...SUPPORTED_INTENTS].join(", ")}).`,
      );
    }
    // Per-mode requirements belong to whoever owns the vocabulary. Ai.Image checks
    // only that an intent came with references; that `inpaint` needs a mask is this
    // fixture's own rule, exactly as it is a real provider's.
    if (intent === "inpaint" && !input.mask) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `EchoImageModel "${name}": intent 'inpaint' repaints a marked region, so 'mask' is required.`,
      );
    }

    const mediaType = this.resource.mediaType ?? "image/png";
    const requested = this.resource.count ?? 1;
    const refusing = this.resource.refuseOn?.prompt !== undefined &&
      this.resource.refuseOn.prompt === input.prompt;
    const produced = refusing ? (this.resource.refuseOn?.keep ?? 0) : requested;

    const descriptor = [
      `prompt=${input.prompt ?? ""}`,
      `intent=${intent ?? ""}`,
      `images=${input.images?.length ?? 0}`,
      `mask=${input.mask ? "1" : "0"}`,
      `options=${JSON.stringify(input.options ?? {})}`,
    ].join("|");

    const images: GeneratedImage[] = [];
    for (let i = 0; i < produced; i++) {
      images.push({
        data: new TextEncoder().encode(`${descriptor}|index=${i}`),
        mediaType,
        ...(this.resource.width !== undefined ? { width: this.resource.width } : {}),
        ...(this.resource.height !== undefined ? { height: this.resource.height } : {}),
        details: { index: i },
      });
    }

    return {
      images,
      finishReason: refusing ? "content-filter" : "stop",
      ...(this.resource.reportUsage
        ? { usage: { unit: "images", total: produced, details: { requested } } }
        : {}),
      text: descriptor,
    };
  }

  snapshot(): Record<string, unknown> {
    return { mediaType: this.resource.mediaType ?? "image/png" };
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: EchoImageResource,
  _ctx: ResourceContext,
): Promise<EchoImageModel> {
  return new EchoImageModel(resource);
}
