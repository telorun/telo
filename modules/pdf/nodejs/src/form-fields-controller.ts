import { PDFDocument } from "pdf-lib";
import type { ControllerContext, ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

interface FormFieldsResource {
  metadata: { name: string; module?: string };
  scale?: number;
}

type FieldType = "text" | "checkbox";

interface FieldPlacement {
  name: string;
  type: FieldType;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FormFieldsInputs {
  data: Uint8Array;
  fields: FieldPlacement[];
  scale?: number;
}

interface FormFieldsOutputs {
  data: Uint8Array;
}

/**
 * Adds editable AcroForm fields to a PDF via pdf-lib. Incoming coordinates
 * are pixels of the image `Pdf.Rasterizer` renders at the same `scale`,
 * origin top-left; this controller divides them back to PDF points and flips
 * the y-axis to PDF user space (origin bottom-left), so neither manifests nor
 * vision models ever translate coordinates.
 */
class PdfFormFields implements ResourceInstance<FormFieldsInputs, FormFieldsOutputs> {
  constructor(private readonly resource: FormFieldsResource) {}

  async invoke(inputs: FormFieldsInputs): Promise<FormFieldsOutputs> {
    const label = `Pdf.FormFields "${this.resource.metadata.name}"`;
    const scale = inputs?.scale ?? this.resource.scale ?? 1;
    if (typeof scale !== "number" || !(scale > 0)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `${label}: 'scale' must be a positive number; got ${scale}.`,
      );
    }
    const data = inputs?.data;
    if (!(data instanceof Uint8Array)) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `${label}: 'data' must be a Uint8Array of PDF bytes; got ${typeof data}.`,
      );
    }

    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(data);
    } catch (err) {
      throw new InvokeError(
        "ERR_INVALID_INPUT",
        `${label}: failed to parse PDF — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const form = doc.getForm();
    const existing = new Set(form.getFields().map((f) => f.getName()));
    const batch = new Set<string>();
    const pageCount = doc.getPageCount();

    for (const field of inputs.fields) {
      if (existing.has(field.name)) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `${label}: field name "${field.name}" already exists in the document.`,
        );
      }
      if (batch.has(field.name)) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `${label}: field name "${field.name}" is duplicated in 'fields'.`,
        );
      }
      batch.add(field.name);

      if (!Number.isInteger(field.page) || field.page < 1 || field.page > pageCount) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `${label}: field "${field.name}" targets page ${field.page}; document has ${pageCount} page(s).`,
        );
      }
      const page = doc.getPage(field.page - 1);

      if (field.x < 0 || field.y < 0 || !(field.width > 0) || !(field.height > 0)) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `${label}: field "${field.name}" box (${field.x}, ${field.y}, ${field.width}×${field.height} px) ` +
            `is invalid — x/y must be ≥ 0 and width/height > 0.`,
        );
      }

      // Pixels at `scale`, top-left origin → points, bottom-left origin.
      const x = field.x / scale;
      const yTop = field.y / scale;
      const width = field.width / scale;
      const height = field.height / scale;
      const y = page.getHeight() - yTop - height;
      if (x + width > page.getWidth() || yTop + height > page.getHeight()) {
        throw new InvokeError(
          "ERR_INVALID_INPUT",
          `${label}: field "${field.name}" box (${field.x}, ${field.y}, ${field.width}×${field.height} px ` +
            `at scale ${scale}) falls outside page ${field.page} ` +
            `(${page.getWidth()}×${page.getHeight()} pt).`,
        );
      }

      const placement = { x, y, width, height };
      if (field.type === "checkbox") {
        form.createCheckBox(field.name).addToPage(page, placement);
      } else {
        form.createTextField(field.name).addToPage(page, placement);
      }
    }

    return { data: await doc.save() };
  }

  snapshot(): Record<string, unknown> {
    return { scale: this.resource.scale ?? 1 };
  }
}

export function register(ctx: ControllerContext): void {}

export async function create(
  resource: FormFieldsResource,
  ctx: ResourceContext,
): Promise<PdfFormFields> {
  return new PdfFormFields(resource);
}

export const schema = {
  type: "object",
  additionalProperties: true,
};
