import type {
  ControllerContext,
  InvokeContext,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import type {
  AiImageModelInstance,
  ImageBytes,
  ImageGenerationResult,
  ImageInvokeInput,
} from "./types.js";

/**
 * Ai.Image — the buffered image-generation operation, symmetric to Ai.Text.
 *
 * It merges options, checks the input combinations a schema cannot express, and
 * hands the call to the model. It deliberately does NOT validate the result: the
 * model's `invoke` is a bound entry point, so the kernel already AJV-checks what
 * comes back against the manifest-declared `ImageResult`. Re-checking here would
 * duplicate the contract in TypeScript, which is exactly what declaring it in the
 * manifest replaced.
 *
 * `intent` is resource config rather than a per-call input: its accepted values are
 * derived from the referenced provider's `$defs/Intent`, so an unsupported mode is
 * a `telo check` error. The controller only enforces the combinations that follow
 * from it — references required when an intent is set, a mask required to inpaint.
 */

interface AiImageResource {
  metadata: { name: string; module?: string };
  /** Replaced in-place with the live provider instance by Phase 5 ref injection. */
  model: AiImageModelInstance;
  intent?: string;
  options?: Record<string, unknown>;
}

interface AiImageInputs {
  prompt?: string;
  images?: ImageBytes[];
  mask?: ImageBytes;
  options?: Record<string, unknown>;
}

class AiImage implements ResourceInstance<AiImageInputs, ImageGenerationResult> {
  constructor(private readonly resource: AiImageResource) {}

  async invoke(
    inputs: AiImageInputs = {},
    ctx?: InvokeContext,
  ): Promise<ImageGenerationResult> {
    const name = this.resource.metadata.name;
    const intent = this.resource.intent;
    const hasPrompt = typeof inputs.prompt === "string" && inputs.prompt.length > 0;
    const images = inputs.images ?? [];

    // Only the rules that follow from the SHAPE are enforced here: an intent is what
    // says the references are for, so one implies the other, and with neither there
    // is nothing to draw from but a prompt. What a particular mode needs — whether it
    // can work without a prompt, whether it takes a mask — belongs to whoever owns
    // the vocabulary, which is the provider (`$defs/Intent`). Name-matching modes
    // here would make `variation` and `inpaint` mean something to this module and
    // silently mean nothing to a backend that calls them `remix` and `outpaint`.
    if (intent === undefined) {
      if (!hasPrompt) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Ai.Image "${name}": 'prompt' is required.`,
        );
      }
      if (images.length > 0) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Ai.Image "${name}": 'images' were supplied but no 'intent' is configured — set 'intent' on the resource to say what they are for, or drop them to generate from the prompt alone.`,
        );
      }
      if (inputs.mask) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Ai.Image "${name}": a 'mask' was supplied but no 'intent' is configured — a mask marks what to repaint, which only means something under an intent that repaints. Set 'intent' on the resource, or drop the mask.`,
        );
      }
    } else if (images.length === 0) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Ai.Image "${name}": intent '${intent}' works from reference images, but none were supplied.`,
      );
    }

    // No `options` type guard here: this kind's inputType declares `options` as an
    // object, and the kernel binds that contract at create(), so a string or array
    // is already rejected with ERR_INPUT_INVALID before invoke() runs. Re-checking
    // would be dead code that also lies about which error an author should catch.

    const model = this.resource.model;
    if (!model || typeof model.invoke !== "function") {
      throw new InvokeError(
        "ERR_INVALID_REFERENCE",
        `Ai.Image "${name}": 'model' is not a live Ai.ImageModel instance — check that Phase 5 injection ran and the referenced resource exists.`,
      );
    }

    const request: ImageInvokeInput = {
      ...(hasPrompt ? { prompt: inputs.prompt } : {}),
      ...(intent !== undefined ? { intent } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(inputs.mask ? { mask: inputs.mask } : {}),
      options: { ...(this.resource.options ?? {}), ...(inputs.options ?? {}) },
    };

    // Every argument forwarded, so the provider reaches cancellation through the
    // InvokeContext the way any bound entry point does.
    return model.invoke(request, ctx);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: AiImageResource,
  _ctx: ResourceContext,
): Promise<AiImage> {
  return new AiImage(resource);
}
