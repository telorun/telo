import type { Canvas } from "@napi-rs/canvas";
import { InvokeError } from "@telorun/sdk";

export type ImageFormat = "png" | "jpeg" | "webp";

const MEDIA_TYPE: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export interface EncodeOptions {
  format?: string;
  quality?: number;
}

export interface EncodedImage {
  image: Uint8Array;
  mediaType: string;
}

/**
 * Encodes a canvas to the requested format, resolving format/quality against
 * resource defaults. `quality` (1–100) applies only to the lossy formats —
 * it is ignored for png, which is inherently lossless. The library clamps an
 * out-of-range quality silently, so the bound is enforced here instead.
 */
export function encodeCanvas(
  canvas: Canvas,
  input: EncodeOptions,
  resource: EncodeOptions,
  label: string,
): EncodedImage {
  const format = (input.format ?? resource.format ?? "png") as ImageFormat;
  if (format !== "png" && format !== "jpeg" && format !== "webp") {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `${label}: 'format' must be one of png, jpeg, webp; got ${JSON.stringify(format)}.`,
    );
  }
  const mediaType = MEDIA_TYPE[format];

  if (format === "png") {
    return { image: new Uint8Array(canvas.toBuffer("image/png")), mediaType };
  }

  const quality = input.quality ?? resource.quality ?? 80;
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new InvokeError(
      "ERR_INVALID_INPUT",
      `${label}: 'quality' must be an integer between 1 and 100; got ${quality}.`,
    );
  }
  return {
    image: new Uint8Array(canvas.toBuffer(mediaType as "image/jpeg" | "image/webp", quality)),
    mediaType,
  };
}
