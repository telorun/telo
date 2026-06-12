import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";
import { encodeCanvas } from "./encode.js";

// Canvas backends cap texture dimensions around here; beyond it allocation
// fails opaquely or silently, so reject up front with the field named.
const MAX_DIMENSION = 16384;

interface BlankResource {
  metadata: { name: string; module?: string };
  color?: string;
  format?: string;
  quality?: number;
}

interface BlankInputs {
  width: number;
  height: number;
  color?: string;
  format?: string;
  quality?: number;
}

interface BlankOutputs {
  image: Uint8Array;
  width: number;
  height: number;
  mediaType: string;
}

/**
 * Produces a solid-color canvas in the requested format — the seed of an
 * image pipeline (compose with `Image.Overlay`) or a hermetic test fixture
 * that replaces embedded base64 images.
 */
class ImageBlank implements ResourceInstance<BlankInputs, BlankOutputs> {
  constructor(private readonly resource: BlankResource) {}

  async invoke(inputs: BlankInputs): Promise<BlankOutputs> {
    const label = `Image.Blank "${this.resource.metadata.name}"`;
    for (const side of ["width", "height"] as const) {
      const value = inputs?.[side];
      if (!Number.isInteger(value) || value < 1 || value > MAX_DIMENSION) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `${label}: '${side}' must be an integer between 1 and ${MAX_DIMENSION}; got ${value}.`,
        );
      }
    }
    const color = inputs.color ?? this.resource.color ?? "#FFFFFF";

    const canvas = createCanvas(inputs.width, inputs.height);
    const ctx = canvas.getContext("2d");
    assertValidColor(ctx, color, label);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, inputs.width, inputs.height);
    const { image, mediaType } = encodeCanvas(canvas, inputs, this.resource, label);
    return { image, width: inputs.width, height: inputs.height, mediaType };
  }

  snapshot(): Record<string, unknown> {
    return { color: this.resource.color ?? "#FFFFFF" };
  }
}

/** Canvas silently keeps the previous fillStyle when assigned an invalid
 *  color — probe with two sentinels so a bad color is an error, not a
 *  default-black canvas. (Two, because a valid color may normalize to the
 *  first sentinel's own value.) */
function assertValidColor(ctx: SKRSContext2D, color: string, label: string): void {
  for (const sentinel of ["#010203", "#040506"]) {
    ctx.fillStyle = sentinel;
    ctx.fillStyle = color;
    if (ctx.fillStyle !== sentinel) return;
  }
  throw new InvokeError(
    "ERR_INVALID_INPUT",
    `${label}: 'color' is not a recognized CSS color: ${JSON.stringify(color)}.`,
  );
}

export function register(ctx: ControllerContext): void {}

export async function create(
  resource: BlankResource,
  ctx: ResourceContext,
): Promise<ImageBlank> {
  return new ImageBlank(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
