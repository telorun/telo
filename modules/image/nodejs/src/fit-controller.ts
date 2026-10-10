import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { encodeCanvas } from "./encode.js";
import { ImageHeaderError, readImageHeader, withUprightTag, type ImageHeader } from "./image-header.js";

const DEFAULT_MAX_BYTES = 26214400;
const DEFAULT_MAX_PIXELS = 40000000;

interface FitResource {
  metadata: { name: string; module?: string };
  format?: string;
  quality?: number;
  maxBytes?: number;
  maxPixels?: number;
}

interface FitInputs {
  image: Uint8Array;
  maxWidth: number;
  maxHeight: number;
  format?: string;
  quality?: number;
}

interface FitOutputs {
  image: Uint8Array;
  width: number;
  height: number;
  mediaType: string;
}

/**
 * Image.Fit — an image scaled down to fit a box and re-encoded.
 *
 * Both limits are judged from the header, before a decoder is handed the bytes.
 * An EXIF orientation — a JPEG's, a WebP's or a PNG's — is neutralised in the
 * copy that is decoded and applied here, so the result is upright exactly once
 * whether or not the decoder honours the tag itself.
 */
class ImageFit implements ResourceInstance<FitInputs, FitOutputs> {
  private readonly label: string;
  private readonly maxBytes: number;
  private readonly maxPixels: number;

  constructor(private readonly resource: FitResource) {
    this.label = `Image.Fit "${resource.metadata.name}"`;
    this.maxBytes = Number(resource.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxPixels = Number(resource.maxPixels ?? DEFAULT_MAX_PIXELS);
  }

  async invoke(inputs: FitInputs): Promise<FitOutputs> {
    const data = inputs.image;
    if (data.byteLength > this.maxBytes) {
      throw this.tooLarge("maxBytes", this.maxBytes, `is ${data.byteLength} bytes`);
    }
    const header = this.header(data);
    if (header.width * header.height > this.maxPixels) {
      throw this.tooLarge(
        "maxPixels",
        this.maxPixels,
        `declares ${header.width}x${header.height} pixels`,
      );
    }

    const tag = header.orientation;
    const source = await this.decode(tag === undefined ? data : withUprightTag(data, tag));
    const orientation = tag?.value ?? 1;
    // Orientations 5–8 turn the image a quarter, so upright it is as wide as
    // it is stored tall.
    const turned = orientation >= 5;
    const uprightWidth = turned ? source.height : source.width;
    const uprightHeight = turned ? source.width : source.height;

    const maxWidth = Number(inputs.maxWidth);
    const maxHeight = Number(inputs.maxHeight);
    const scale = Math.min(1, maxWidth / uprightWidth, maxHeight / uprightHeight);
    const width = Math.min(maxWidth, Math.max(1, Math.round(uprightWidth * scale)));
    const height = Math.min(maxHeight, Math.max(1, Math.round(uprightHeight * scale)));

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    turnUpright(ctx, orientation, width, height);
    ctx.drawImage(source, 0, 0, turned ? height : width, turned ? width : height);

    const { image, mediaType } = await encodeCanvas(canvas, inputs, this.resource, this.label);
    return { image, width, height, mediaType };
  }

  private header(data: Uint8Array): ImageHeader {
    try {
      return readImageHeader(data);
    } catch (err) {
      if (err instanceof ImageHeaderError) throw this.unsupported(err.message);
      throw err;
    }
  }

  private async decode(data: Uint8Array): Promise<Image> {
    try {
      return await loadImage(data);
    } catch (err) {
      throw this.unsupported(
        `The image could not be decoded — ${err instanceof Error ? err.message : String(err)}.`,
      );
    }
  }

  private tooLarge(limit: "maxBytes" | "maxPixels", max: number, found: string): InvokeError {
    return new InvokeError(
      "ERR_IMAGE_TOO_LARGE",
      `${this.label}: the image ${found}, over the ${max} '${limit}' allows; it was not decoded.`,
      { limit, max },
    );
  }

  private unsupported(reason: string): InvokeError {
    return new InvokeError("ERR_UNSUPPORTED_IMAGE", `${this.label}: ${reason}`);
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

/** Maps the stored image onto an upright canvas of `width` × `height`, for
 *  each EXIF orientation. */
function turnUpright(ctx: SKRSContext2D, orientation: number, width: number, height: number): void {
  switch (orientation) {
    case 2:
      return ctx.transform(-1, 0, 0, 1, width, 0);
    case 3:
      return ctx.transform(-1, 0, 0, -1, width, height);
    case 4:
      return ctx.transform(1, 0, 0, -1, 0, height);
    case 5:
      return ctx.transform(0, 1, 1, 0, 0, 0);
    case 6:
      return ctx.transform(0, 1, -1, 0, width, 0);
    case 7:
      return ctx.transform(0, -1, -1, 0, width, height);
    case 8:
      return ctx.transform(0, -1, 1, 0, 0, height);
  }
}

export function register(ctx: ControllerContext): void {}

export async function create(resource: FitResource, ctx: ResourceContext): Promise<ImageFit> {
  return new ImageFit(resource);
}
