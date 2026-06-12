import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { encodeCanvas } from "./encode.js";

type LabelPlacement = "top-left" | "top-right" | "bottom-left" | "bottom-right";

interface OverlayResource {
  metadata: { name: string; module?: string };
  stroke?: { color?: string; width?: number };
  label?: { color?: string; background?: string; size?: number; placement?: LabelPlacement };
  format?: string;
  quality?: number;
}

interface Shape {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  color?: string;
}

interface OverlayInputs {
  image: Uint8Array;
  shapes: Shape[];
  format?: string;
  quality?: number;
}

interface OverlayOutputs {
  image: Uint8Array;
  width: number;
  height: number;
  mediaType: string;
}

const LABEL_PADDING = 4;

/**
 * Draws labelled rectangles onto an image and returns it in the requested
 * format.
 * Visualization, not mutation: shapes are drawn as given and clipped at the
 * image edges — showing a wrong proposal is the point of a review loop.
 */
class ImageOverlay implements ResourceInstance<OverlayInputs, OverlayOutputs> {
  constructor(private readonly resource: OverlayResource) {}

  async invoke(inputs: OverlayInputs): Promise<OverlayOutputs> {
    const label = `Image.Overlay "${this.resource.metadata.name}"`;
    const data = inputs?.image;
    if (!(data instanceof Uint8Array)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `${label}: 'image' must be a Uint8Array of image bytes; got ${typeof data}.`,
      );
    }
    for (const shape of inputs.shapes) {
      const finite =
        Number.isFinite(shape.x) &&
        Number.isFinite(shape.y) &&
        Number.isFinite(shape.width) &&
        Number.isFinite(shape.height);
      if (!finite || !(shape.width > 0) || !(shape.height > 0)) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `${label}: shape (${shape.x}, ${shape.y}, ${shape.width}×${shape.height}) is invalid — ` +
            `coordinates must be finite and width/height > 0.`,
        );
      }
    }

    let source;
    try {
      source = await loadImage(data);
    } catch (err) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `${label}: failed to decode image — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const width = source.width;
    const height = source.height;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0);

    const strokeColor = this.resource.stroke?.color ?? "#FF3B30";
    const strokeWidth = this.resource.stroke?.width ?? 3;
    const labelColor = this.resource.label?.color ?? "#FFFFFF";
    const labelSize = this.resource.label?.size ?? 14;
    const placement = this.resource.label?.placement ?? "top-left";

    for (const shape of inputs.shapes) {
      const color = shape.color ?? strokeColor;
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = color;
      ctx.strokeRect(shape.x, shape.y, shape.width, shape.height);

      if (shape.label === undefined || shape.label === "") continue;
      ctx.font = `${labelSize}px sans-serif`;
      const text = ctx.measureText(shape.label);
      const tabWidth = text.width + 2 * LABEL_PADDING;
      const tabHeight = labelSize + 2 * LABEL_PADDING;
      const tabX = placement.endsWith("right") ? shape.x + shape.width - tabWidth : shape.x;
      const tabY = placement.startsWith("top") ? shape.y - tabHeight : shape.y + shape.height;
      // Clamp into the image so an edge-hugging box still shows its tag.
      const x = Math.min(Math.max(tabX, 0), width - tabWidth);
      const y = Math.min(Math.max(tabY, 0), height - tabHeight);
      ctx.fillStyle = this.resource.label?.background ?? color;
      ctx.fillRect(x, y, tabWidth, tabHeight);
      ctx.fillStyle = labelColor;
      ctx.textBaseline = "top";
      ctx.fillText(shape.label, x + LABEL_PADDING, y + LABEL_PADDING);
    }

    const { image, mediaType } = encodeCanvas(canvas, inputs, this.resource, label);
    return { image, width, height, mediaType };
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

export function register(ctx: ControllerContext): void {}

export async function create(
  resource: OverlayResource,
  ctx: ResourceContext,
): Promise<ImageOverlay> {
  return new ImageOverlay(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
