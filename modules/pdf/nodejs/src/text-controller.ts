import { createRequire } from "node:module";
import { dirname, join } from "node:path";
// The legacy build is pdf.js's Node target — the same one the rasterizer loads.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

const PDFJS_ROOT = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const ASSET_OPTIONS = {
  standardFontDataUrl: join(PDFJS_ROOT, "standard_fonts") + "/",
  cMapUrl: join(PDFJS_ROOT, "cmaps") + "/",
  cMapPacked: true,
  wasmUrl: join(PDFJS_ROOT, "wasm") + "/",
};

interface TextResource {
  metadata: { name: string; module?: string };
}

interface TextInputs {
  data: Uint8Array;
  page?: number;
}

interface TextOutputs {
  text: string;
  pages: string[];
  pageCount: number;
}

/**
 * Reads the text a PDF actually renders.
 *
 * The counterpart to `Pdf.Rasterizer`: rasterizing answers *what does this page
 * look like*, which is a question about pixels and moves with the platform's
 * font rasterization. This answers *what does it say*, which is what an
 * assertion about a generated document needs — a rendered page image cannot
 * tell a correct table from an empty one.
 *
 * Items are joined in the order pdf.js reports them, with a line break at each
 * end-of-line marker. That is reading order for ordinary flowed content; it is
 * not a layout reconstruction, and a multi-column page reads column by column
 * the way the producer wrote it.
 */
class PdfText implements ResourceInstance<TextInputs, TextOutputs> {
  constructor(private readonly resource: TextResource) {}

  async invoke(inputs: TextInputs): Promise<TextOutputs> {
    const name = this.resource.metadata.name;
    const data = inputs?.data;
    if (!(data instanceof Uint8Array)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `Pdf.Text "${name}": 'data' must be a Uint8Array of PDF bytes; got ${typeof data}.`,
      );
    }

    // pdf.js transfers the buffer it is given — hand it a copy so the caller's
    // bytes survive a second read.
    const task = getDocument({ data: new Uint8Array(data), ...ASSET_OPTIONS });
    try {
      const doc = await task.promise.catch((err: unknown) => {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Pdf.Text "${name}": failed to parse PDF — ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      const requested = inputs.page;
      if (requested !== undefined && requested > doc.numPages) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `Pdf.Text "${name}": page ${requested} is out of range; document has ${doc.numPages} page(s).`,
        );
      }
      const first = requested ?? 1;
      const last = requested ?? doc.numPages;
      const pages: string[] = [];
      for (let n = first; n <= last; n++) {
        const page = await doc.getPage(n);
        try {
          pages.push(renderTextContent(await page.getTextContent()));
        } finally {
          page.cleanup();
        }
      }
      return { text: pages.join("\n"), pages, pageCount: doc.numPages };
    } finally {
      await task.destroy();
    }
  }

  snapshot(): Record<string, unknown> {
    return {};
  }
}

interface TextItem {
  str?: string;
  hasEOL?: boolean;
}

function renderTextContent(content: { items: unknown[] }): string {
  let out = "";
  for (const raw of content.items) {
    const item = raw as TextItem;
    if (typeof item.str !== "string") continue;
    out += item.str;
    if (item.hasEOL) out += "\n";
  }
  return out;
}

export function register(): void {}

export async function create(resource: TextResource, _ctx: ResourceContext): Promise<PdfText> {
  return new PdfText(resource);
}
