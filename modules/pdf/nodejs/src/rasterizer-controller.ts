import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type Canvas, createCanvas } from "@napi-rs/canvas";
// The legacy build is pdf.js's Node target: it polyfills DOMMatrix/ImageData/
// Path2D from @napi-rs/canvas; the main build expects browser globals.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// Bundled pdf.js assets (standard 14 fonts, CMaps, wasm image decoders) —
// without these, PDFs using built-in fonts or CJK encodings render degraded.
const PDFJS_ROOT = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const ASSET_OPTIONS = {
  standardFontDataUrl: join(PDFJS_ROOT, "standard_fonts") + "/",
  cMapUrl: join(PDFJS_ROOT, "cmaps") + "/",
  cMapPacked: true,
  wasmUrl: join(PDFJS_ROOT, "wasm") + "/",
};
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

interface RasterizerResource {
  metadata: { name: string; module?: string };
  scale?: number;
  format?: string;
  quality?: number;
}

interface RasterizerInputs {
  data: Uint8Array;
  page?: number;
  format?: string;
  quality?: number;
}

interface RasterizerOutputs {
  image: Uint8Array;
  width: number;
  height: number;
  pageCount: number;
  scale: number;
  mediaType: string;
}

/**
 * Renders one PDF page to image bytes (png/jpeg/webp) via pdf.js on an
 * `@napi-rs/canvas` surface. The reported width/height are the rendered pixel
 * dimensions at the configured `scale` — the coordinate space `Pdf.FormFields`
 * converts back from.
 */
class PdfRasterizer implements ResourceInstance<RasterizerInputs, RasterizerOutputs> {
  constructor(private readonly resource: RasterizerResource) {}

  async invoke(inputs: RasterizerInputs): Promise<RasterizerOutputs> {
    const name = this.resource.metadata.name;
    const scale = this.resource.scale ?? 1;
    const data = inputs?.data;
    if (!(data instanceof Uint8Array)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Pdf.Rasterizer "${name}": 'data' must be a Uint8Array of PDF bytes; got ${typeof data}.`,
      );
    }
    const pageNumber = inputs.page ?? 1;
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Pdf.Rasterizer "${name}": 'page' must be a positive integer; got ${pageNumber}.`,
      );
    }

    const task = loadPdf(data);
    try {
      const doc = await task.promise.catch((err) => {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Pdf.Rasterizer "${name}": failed to parse PDF — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      if (pageNumber > doc.numPages) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Pdf.Rasterizer "${name}": page ${pageNumber} is out of range; document has ${doc.numPages} page(s).`,
        );
      }
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      const canvas = createCanvas(width, height);
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      }).promise;
      page.cleanup();
      const { image, mediaType } = encodeCanvas(canvas, inputs, this.resource, `Pdf.Rasterizer "${name}"`);
      return {
        image,
        width,
        height,
        pageCount: doc.numPages,
        scale,
        mediaType,
      };
    } finally {
      await task.destroy();
    }
  }

  snapshot(): Record<string, unknown> {
    return { scale: this.resource.scale ?? 1 };
  }
}

/** pdf.js transfers the buffer it is given — hand it a copy so the caller's
 *  bytes survive (the same `data` may feed `Pdf.FormFields` next). */
function loadPdf(data: Uint8Array) {
  return getDocument({ data: new Uint8Array(data), ...ASSET_OPTIONS });
}

const MEDIA_TYPE: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Encodes the rendered page to the requested format. `quality` (1–100)
 * applies only to the lossy formats; it is ignored for png. The library
 * clamps an out-of-range quality silently, so the bound is enforced here.
 */
function encodeCanvas(
  canvas: Canvas,
  input: { format?: string; quality?: number },
  resource: { format?: string; quality?: number },
  label: string,
): { image: Uint8Array; mediaType: string } {
  const format = input.format ?? resource.format ?? "png";
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

export function register(ctx: ControllerContext): void {}

export async function create(
  resource: RasterizerResource,
  ctx: ResourceContext,
): Promise<PdfRasterizer> {
  return new PdfRasterizer(resource);
}

