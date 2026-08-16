import { fetchOrThrow } from "@telorun/sdk";
import { redact } from "@telorun/ai";
import type {
  AiImageModelInstance,
  GeneratedImage,
  ImageBytes,
  ImageFinishReason,
  ImageGenerationResult,
  ImageInvokeInput,
  UsageQuantity,
} from "@telorun/ai";
import type {
  ControllerContext,
  InvokeContext,
  ResourceContext,
  ResourceInstance,
} from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { errorMessage, mergeOptions, toOpenAiParams } from "./openai-params.js";

/**
 * OpenAI-compatible provider for the Ai.ImageModel abstract. Speaks the images HTTP
 * API directly (no vendor SDK), so the same controller serves OpenAI plus every
 * OpenAI-compatible endpoint via `baseUrl`.
 *
 * Endpoint selection follows the configured intent, which Ai.Image resolves and the
 * manifest's `$defs/Intent` has already constrained statically:
 *   (none)          → POST /images/generations   (JSON)
 *   edit | inpaint  → POST /images/edits         (multipart; mask is its own part)
 *   variation       → POST /images/variations    (multipart; no prompt)
 *
 * Options merging: this manifest's `options` → the options Ai.Image already merged
 * from its own and the caller's. Shallow, downstream wins; keys are camelCase in the
 * manifest and converted to the wire's snake_case.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

interface OpenaiImageResource {
  metadata: { name: string; module?: string };
  model: string;
  apiKey: string;
  baseUrl?: string;
  options?: Record<string, unknown>;
}

// --- OpenAI wire shapes (only the fields this controller reads) ---

interface OpenAiImageDatum {
  b64_json?: string;
  url?: string;
  revised_prompt?: string;
}

interface OpenAiImageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: Record<string, unknown>;
}

interface OpenAiImageResponse {
  data?: OpenAiImageDatum[];
  usage?: OpenAiImageUsage;
}

/** Error codes that mean "the request was understood and refused on content
 *  grounds". These become a `content-filter` result rather than a thrown error,
 *  because a refusal is a documented outcome of the contract, not a failure the
 *  caller can fix by retrying. Every other error still throws. */
const REFUSAL_CODES = new Set([
  "moderation_blocked",
  "content_policy_violation",
  "content_filter",
]);

/** The reference-image modes this controller has an endpoint for. Mirrors the
 *  manifest's `$defs/Intent`, which is what enforces it statically. */
const SUPPORTED_INTENTS = new Set(["edit", "inpaint", "variation"]);

/** Media type of the produced bytes. gpt-image-1 honours an `output_format` option;
 *  every other model returns PNG. */
function outputMediaType(params: Record<string, unknown>): string {
  const format = params["output_format"];
  if (typeof format === "string" && format.length > 0) return `image/${format}`;
  return "image/png";
}

/** Pixel dimensions, when the request pinned them. Read back from the requested
 *  `size` rather than decoded from the bytes — this controller has no image
 *  library, and guessing would be worse than omitting. `auto` and absent yield
 *  nothing. */
function requestedDimensions(params: Record<string, unknown>): { width?: number; height?: number } {
  const size = params["size"];
  if (typeof size !== "string") return {};
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** `response_format` is a dall-e-only parameter: gpt-image-1 rejects it outright and
 *  always answers with base64. Send it only where it is both accepted and needed. */
function wantsResponseFormat(model: string): boolean {
  return model.startsWith("dall-e");
}

function fileName(mediaType: string, fallback: string): string {
  const subtype = mediaType.split("/")[1] ?? "png";
  return `${fallback}.${subtype}`;
}

function toBlob(part: ImageBytes): Blob {
  // Copy into a fresh view: a Uint8Array over a larger pooled buffer would
  // otherwise contribute the whole pool.
  return new Blob([part.data.slice()], { type: part.mediaType });
}

function mapUsage(u: OpenAiImageUsage | undefined): UsageQuantity | undefined {
  if (!u || typeof u.total_tokens !== "number") return undefined;
  const details: Record<string, unknown> = {};
  if (typeof u.input_tokens === "number") details["inputTokens"] = u.input_tokens;
  if (typeof u.output_tokens === "number") details["outputTokens"] = u.output_tokens;
  if (u.input_tokens_details) details["inputTokensDetails"] = u.input_tokens_details;
  return {
    unit: "tokens",
    total: u.total_tokens,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

class OpenaiImageModelInstance implements ResourceInstance, AiImageModelInstance {
  private readonly baseUrl: string;

  constructor(private readonly resource: OpenaiImageResource) {
    this.baseUrl = (resource.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async invoke(input: ImageInvokeInput, ctx?: InvokeContext): Promise<ImageGenerationResult> {
    const params = toOpenAiParams(mergeOptions(this.resource.options, input.options));
    const signal = ctx?.cancellation.signal;
    const intent = input.intent;
    this.checkIntent(intent, input);

    const request =
      intent === undefined
        ? this.generationRequest(input, params, signal)
        : this.multipartRequest(intent, input, params, signal);

    const res = await fetchOrThrow(`${this.baseUrl}${request.path}`, request.init, {
      operation: "AI image generation",
      resource: this.resource.metadata.name,
      setting: "baseUrl",
    });

    if (!res.ok) {
      const refusal = await this.refusalReason(res);
      // Carry the provider's explanation through: a total refusal otherwise reaches
      // the author as an empty array with no reason, which is the one case where
      // they most need one.
      if (refusal) {
        return { images: [], finishReason: refusal.reason, text: refusal.message };
      }
      throw new Error(await errorMessage(res, "OpenAI image generation"));
    }

    const data = (await res.json()) as OpenAiImageResponse;
    const items = data.data ?? [];
    const mediaType = outputMediaType(params);
    const dimensions = requestedDimensions(params);

    const images: GeneratedImage[] = [];
    for (const item of items) {
      images.push({
        data: await this.imageBytes(item, signal),
        mediaType,
        ...dimensions,
      });
    }

    const revised = items.find((i) => typeof i.revised_prompt === "string")?.revised_prompt;
    const usage = mapUsage(data.usage);
    return {
      images,
      finishReason: "stop",
      ...(usage ? { usage } : {}),
      ...(revised ? { text: revised } : {}),
    };
  }

  /** Text-to-image: a plain JSON body. */
  private generationRequest(
    input: ImageInvokeInput,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): { path: string; init: RequestInit } {
    const body: Record<string, unknown> = {
      model: this.resource.model,
      prompt: input.prompt ?? "",
      ...params,
      ...(wantsResponseFormat(this.resource.model) ? { response_format: "b64_json" } : {}),
    };
    return {
      path: "/images/generations",
      init: {
        method: "POST",
        headers: { "content-type": "application/json", ...this.authHeader() },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
    };
  }

  /** Reference-image intents. `content-type` is deliberately NOT set: the runtime
   *  fills in the multipart boundary, and setting it by hand produces a body the
   *  server cannot parse. */
  private multipartRequest(
    intent: string,
    input: ImageInvokeInput,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): { path: string; init: RequestInit } {
    const images = input.images ?? [];
    const form = new FormData();
    form.append("model", this.resource.model);

    // One reference goes on `image`; several go on `image[]`, which only the
    // multi-reference models accept — sending the array form for a single image
    // would break the ones that do not.
    if (images.length === 1) {
      form.append("image", toBlob(images[0]), fileName(images[0].mediaType, "image"));
    } else {
      for (const [i, part] of images.entries()) {
        form.append("image[]", toBlob(part), fileName(part.mediaType, `image-${i}`));
      }
    }

    const variation = intent === "variation";
    if (!variation && input.prompt) form.append("prompt", input.prompt);
    if (input.mask) form.append("mask", toBlob(input.mask), fileName(input.mask.mediaType, "mask"));

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      form.append(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    // Only when the author has not set it: FormData APPENDS rather than replaces, so
    // an unconditional add would send two `response_format` parts. The JSON path has
    // no such hazard — it spreads after `params`, which overwrites.
    if (wantsResponseFormat(this.resource.model) && !("response_format" in params)) {
      form.append("response_format", "b64_json");
    }

    return {
      path: variation ? "/images/variations" : "/images/edits",
      init: {
        method: "POST",
        headers: this.authHeader(),
        body: form,
        ...(signal ? { signal } : {}),
      },
    };
  }

  private authHeader(): Record<string, string> {
    return this.resource.apiKey ? { authorization: `Bearer ${this.resource.apiKey}` } : {};
  }

  /** The intents this controller routes. The manifest's `$defs/Intent` is what makes
   *  an unknown one a `telo check` error; this is the backstop for a consumer whose
   *  manifest predates that declaration. Without it an unrecognised intent would be
   *  silently routed to /images/edits, which is a wrong answer rather than an error.
   *  Per-mode requirements live here too — the vocabulary is this provider's, so its
   *  rules are as well. */
  private checkIntent(intent: string | undefined, input: ImageInvokeInput): void {
    if (intent === undefined) return;
    const label = `AiOpenai.OpenaiImageModel "${this.resource.metadata.name}"`;
    if (!SUPPORTED_INTENTS.has(intent)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `${label}: unsupported intent '${intent}' (serves: ${[...SUPPORTED_INTENTS].join(", ")}).`,
      );
    }
    if (intent === "inpaint" && !input.mask) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `${label}: intent 'inpaint' repaints a marked region, so 'mask' is required.`,
      );
    }
    if (intent === "edit" && !input.prompt) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `${label}: intent 'edit' reworks the reference per a prompt, so 'prompt' is required.`,
      );
    }
  }

  /** Classify a non-OK response: a content refusal is an outcome the contract models,
   *  anything else is an error the caller must see. Returns undefined for the latter
   *  so the caller throws with the provider's own message. */
  private async refusalReason(
    res: Response,
  ): Promise<{ reason: ImageFinishReason; message: string } | undefined> {
    let body = "";
    try {
      body = await res.clone().text();
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string; type?: string; message?: string } };
      const code = parsed.error?.code ?? parsed.error?.type;
      if (typeof code === "string" && REFUSAL_CODES.has(code)) {
        return {
          reason: "content-filter",
          message: parsed.error?.message ?? `The request was refused (${code}).`,
        };
      }
    } catch {
      // Non-JSON body — not a structured refusal, so it is a plain failure.
    }
    return undefined;
  }

  /** Take the bytes from the response item. Base64 is what we ask for, but a
   *  gateway (or a model that ignores `response_format`) may answer with a URL —
   *  fetch it rather than returning an image-shaped hole. */
  private async imageBytes(item: OpenAiImageDatum, signal: AbortSignal | undefined): Promise<Uint8Array> {
    if (typeof item.b64_json === "string") {
      return new Uint8Array(Buffer.from(item.b64_json, "base64"));
    }
    if (typeof item.url === "string") {
      // No `setting:` hint — this URL came from the provider's own response, so
      // pointing the author at a manifest field they cannot use to fix it would be
      // worse than saying nothing.
      const res = await fetchOrThrow(item.url, signal ? { signal } : {}, {
        operation: "AI image download",
        resource: this.resource.metadata.name,
      });
      if (!res.ok) throw new Error(await errorMessage(res, "OpenAI image download"));
      return new Uint8Array(await res.arrayBuffer());
    }
    throw new Error(
      `OpenAI image generation returned an item with neither 'b64_json' nor 'url' (resource '${this.resource.metadata.name}').`,
    );
  }

  snapshot(): Record<string, unknown> {
    return redact(["apiKey"], this.resource);
  }
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: OpenaiImageResource,
  _ctx: ResourceContext,
): Promise<OpenaiImageModelInstance> {
  return new OpenaiImageModelInstance(resource);
}
