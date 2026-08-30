import { fetchOrThrow } from "@telorun/sdk";
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
import {
  isSuccess,
  openAiFailure,
  sendOpenAi,
  type HttpRequestInstance,
  type OpenAiCall,
  type OpenAiResponse,
} from "./openai-endpoint.js";
import { errorMessage, mergeOptions, toOpenAiParams } from "./openai-params.js";

/**
 * OpenAI-compatible provider for the Ai.ImageModel abstract, over the images
 * HTTP API through an injected `Http.Request` — see openai-endpoint.ts for why
 * not `fetch`.
 *
 * Endpoint selection follows the configured intent, which Ai.Image resolves and the
 * manifest's `$defs/Intent` has already constrained statically:
 *   (none)          → POST /images/generations   (JSON)
 *   edit | inpaint  → POST /images/edits         (multipart; mask is its own part)
 *   variation       → POST /images/variations    (multipart; no prompt)
 *
 * A multipart body is framed by Node's own `FormData` encoder (undici, through
 * `new Response(form)` — host-specific; a port uses its host's) and sent as BYTES
 * under the content type it produced (boundary included). Bytes rather than
 * the stream the encoder could also give: the request is replayable, so the 401
 * re-acquire-and-retry `http-client` owns still applies — a stream body is
 * refused there — and the parts are already in memory.
 *
 * Options merging: this manifest's `options` → the options Ai.Image already merged
 * from its own and the caller's. Shallow, downstream wins; keys are camelCase in the
 * manifest and converted to the wire's snake_case.
 */

interface OpenaiImageResource {
  metadata: { name: string; module?: string };
  model: string;
  request: HttpRequestInstance;
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

const OPERATION = "OpenAI image generation";

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

/** Frame a form the way Node's fetch would, and read back the content type it
 *  chose — the boundary lives in both, so they come from one place. */
async function frameForm(form: FormData): Promise<{ body: Uint8Array; contentType: string }> {
  const framed = new Response(form);
  const contentType = framed.headers.get("content-type");
  if (!contentType) {
    throw new Error(`${OPERATION}: the runtime produced a multipart body with no content type.`);
  }
  return { body: new Uint8Array(await framed.arrayBuffer()), contentType };
}

class OpenaiImageModelInstance implements ResourceInstance, AiImageModelInstance {
  constructor(private readonly resource: OpenaiImageResource) {}

  async invoke(input: ImageInvokeInput, ctx?: InvokeContext): Promise<ImageGenerationResult> {
    const params = toOpenAiParams(mergeOptions(this.resource.options, input.options));
    const intent = input.intent;
    this.checkIntent(intent, input);

    const call =
      intent === undefined
        ? this.generationCall(input, params)
        : await this.multipartCall(intent, input, params);

    const response = await sendOpenAi(
      this.resource.request,
      this.resource.metadata.name,
      OPERATION,
      call,
      ctx,
    );

    if (!isSuccess(response)) {
      const refusal = refusalReason(response);
      // Carry the provider's explanation through: a total refusal otherwise reaches
      // the author as an empty array with no reason, which is the one case where
      // they most need one.
      if (refusal) {
        return { images: [], finishReason: refusal.reason, text: refusal.message };
      }
      throw openAiFailure(this.resource.metadata.name, OPERATION, response);
    }

    const data = response.body as OpenAiImageResponse;
    const items = data.data ?? [];
    const mediaType = outputMediaType(params);
    const dimensions = requestedDimensions(params);

    const images: GeneratedImage[] = [];
    for (const item of items) {
      images.push({
        data: await this.imageBytes(item, ctx?.cancellation.signal),
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
  private generationCall(input: ImageInvokeInput, params: Record<string, unknown>): OpenAiCall {
    return {
      path: "/images/generations",
      body: {
        model: this.resource.model,
        prompt: input.prompt ?? "",
        ...params,
        ...(wantsResponseFormat(this.resource.model) ? { response_format: "b64_json" } : {}),
      },
    };
  }

  /** Reference-image intents: named binary parts, framed and sent as bytes. */
  private async multipartCall(
    intent: string,
    input: ImageInvokeInput,
    params: Record<string, unknown>,
  ): Promise<OpenAiCall> {
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
      ...(await frameForm(form)),
    };
  }

  /** The intents this controller routes. The manifest's `$defs/Intent` is what makes
   *  an unknown one a `telo check` error; this is the backstop for a consumer whose
   *  manifest predates that declaration. Without it an unrecognised intent would be
   *  silently routed to /images/edits, which is a wrong answer rather than an error.
   *  Per-mode requirements live here too — the vocabulary is this provider's, so its
   *  rules are as well. */
  private checkIntent(intent: string | undefined, input: ImageInvokeInput): void {
    if (intent === undefined) return;
    const label = `OpenAI.ImageModel "${this.resource.metadata.name}"`;
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

  /** Take the bytes from the response item. Base64 is what we ask for, but a
   *  gateway (or a model that ignores `response_format`) may answer with a URL —
   *  fetch it rather than returning an image-shaped hole. A direct fetch, not the
   *  injected request: the URL is the provider's own, off the account's base URL,
   *  and carries its own access token. */
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
      `${OPERATION} returned an item with neither 'b64_json' nor 'url' (resource '${this.resource.metadata.name}').`,
    );
  }

  /** Nothing to redact: the key is the client's. */
  snapshot(): Record<string, unknown> {
    return { model: this.resource.model, ...(this.resource.options ? { options: this.resource.options } : {}) };
  }
}

/** Classify a non-OK response: a content refusal is an outcome the contract models,
 *  anything else is an error the caller must see. The body is already parsed by
 *  `Http.Request` when the endpoint answered JSON. */
function refusalReason(
  response: OpenAiResponse,
): { reason: ImageFinishReason; message: string } | undefined {
  let parsed: { error?: { code?: string; type?: string; message?: string } } | undefined;
  if (typeof response.body === "string") {
    try {
      parsed = JSON.parse(response.body);
    } catch {
      return undefined;
    }
  } else if (response.body && typeof response.body === "object") {
    parsed = response.body as typeof parsed;
  }
  const code = parsed?.error?.code ?? parsed?.error?.type;
  if (typeof code === "string" && REFUSAL_CODES.has(code)) {
    return {
      reason: "content-filter",
      message: parsed?.error?.message ?? `The request was refused (${code}).`,
    };
  }
  return undefined;
}

export function register(_ctx: ControllerContext): void {}

export async function create(
  resource: OpenaiImageResource,
  _ctx: ResourceContext,
): Promise<OpenaiImageModelInstance> {
  return new OpenaiImageModelInstance(resource);
}
