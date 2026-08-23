import pdfMake from "pdfmake/build/pdfmake.js";
import robotoVfs from "pdfmake/build/vfs_fonts.js";
import type { ResourceContext, ResourceInstance } from "@telorun/sdk";
import { InvokeError } from "@telorun/sdk";

/** The faces pdfmake looks for in a family, in the order a missing one falls
 *  back through. `normal` is required by the schema, so the chain terminates. */
const FACES = ["normal", "bold", "italics", "bolditalics"] as const;
type Face = (typeof FACES)[number];

/** pdfmake ships Roboto in its own virtual filesystem, so a document renders
 *  with no font configuration at all. Registered under the name pdfmake's own
 *  examples use, which is what makes a pasted example work unchanged. */
const ROBOTO = {
  normal: "Roboto-Regular.ttf",
  bold: "Roboto-Medium.ttf",
  italics: "Roboto-Italic.ttf",
  bolditalics: "Roboto-MediumItalic.ttf",
};

interface DocumentResource {
  metadata: { name: string; module?: string };
  content: unknown;
  background?: unknown;
  header?: unknown;
  footer?: unknown;
  pageSize?: unknown;
  pageOrientation?: string;
  pageMargins?: number[];
  defaultStyle?: Record<string, unknown>;
  styles?: Record<string, unknown>;
  fonts?: Record<string, Partial<Record<Face, Uint8Array>>>;
  images?: Record<string, string>;
  info?: Record<string, string>;
  compress?: boolean;
  userPassword?: string;
  ownerPassword?: string;
}

interface DocumentOutputs {
  bytes: Uint8Array;
}

/** The declarative table layout an author writes. */
interface DeclaredLayout {
  hLineWidth?: number;
  vLineWidth?: number;
  hLineColor?: string;
  vLineColor?: string;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  fillColor?: string;
  headerFillColor?: string;
  oddRowFillColor?: string;
}

/**
 * Renders a declared document to PDF bytes through pdfmake.
 *
 * The expression-bearing fields are expanded PER INVOCATION against that
 * call's `inputs`, which is what makes one document resource a report template
 * rather than one fixed document: the same declaration renders a different
 * customer's rows each time it is invoked.
 *
 * Embedded fonts are handed to pdfmake through its virtual filesystem under
 * synthesized names. The bytes come from `!include-bytes`, so a brand font is
 * part of the module's own artifact and there is no file to find at runtime.
 */
class PdfMakeDocument implements ResourceInstance<Record<string, unknown>, DocumentOutputs> {
  /** Built once — the font bytes are configuration, not per-call data. */
  private readonly vfs: Record<string, Uint8Array | string>;
  private readonly fonts: Record<string, Record<string, string>>;

  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: DocumentResource,
  ) {
    const { vfs, fonts } = registerFonts(resource);
    this.vfs = vfs;
    this.fonts = fonts;
  }

  async invoke(inputs: Record<string, unknown>): Promise<DocumentOutputs> {
    const name = this.resource.metadata.name;
    const scope = { inputs: inputs ?? {} };
    const expand = (value: unknown): unknown =>
      value === undefined ? undefined : this.ctx.expandValue(value, scope);

    const definition: Record<string, unknown> = {
      content: toPdfMakeLayouts(expand(this.resource.content)),
      background: toPdfMakeLayouts(expand(this.resource.background)),
      header: toPdfMakeLayouts(expand(this.resource.header)),
      footer: toPdfMakeLayouts(expand(this.resource.footer)),
      pageSize: this.resource.pageSize,
      pageOrientation: this.resource.pageOrientation,
      pageMargins: this.resource.pageMargins,
      defaultStyle: this.resource.defaultStyle,
      styles: this.resource.styles,
      images: this.resource.images,
      info: this.resource.info,
      compress: this.resource.compress,
      userPassword: this.resource.userPassword,
      ownerPassword: this.resource.ownerPassword,
    };
    for (const key of Object.keys(definition)) {
      if (definition[key] === undefined) delete definition[key];
    }

    // pdfmake reads its fonts and virtual filesystem off the module object at
    // createPdf time rather than taking them as arguments, so both are set on
    // each call.
    //
    // What isolates two documents is the `fonts` MAP, replaced wholesale here
    // and read synchronously by `createPdf` below. The virtual filesystem is
    // MERGED by pdfmake, never replaced, so every document's bytes accumulate
    // there for the process lifetime — which is why the file names are keyed by
    // resource (see `registerFonts`): two documents each declaring a family
    // called `Brand` would otherwise write the same entry, and whichever
    // rendered last would silently decide the font for both.
    pdfMake.addVirtualFileSystem(this.vfs);
    pdfMake.fonts = this.fonts;

    let buffer: Buffer;
    try {
      buffer = await pdfMake.createPdf(definition).getBuffer();
    } catch (err) {
      throw new InvokeError(
        "ERR_RENDER_FAILED",
        `PdfMake.Document "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { bytes: new Uint8Array(buffer) };
  }

  snapshot(): Record<string, unknown> {
    return { fonts: Object.keys(this.fonts) };
  }
}

/**
 * Rewrites every declared `layout` object into the callbacks pdfmake expects.
 *
 * This is the one place the binding is not a mirror, and it cannot be one: a
 * manifest holds no functions, and pdfmake invokes these synchronously during
 * layout, so an expression could not fill them either. What an author declares
 * is the data a callback would have returned — line widths and colours,
 * padding, a header fill, an alternating band — and a row that must look
 * different is a row carrying a different `style`, which travels in the data.
 *
 * Header rows are counted from the table beside the layout, since that is what
 * `headerFillColor` and `oddRowFillColor` are relative to.
 */
function toPdfMakeLayouts(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPdfMakeLayouts);
  if (value === null || typeof value !== "object") return value;
  const node = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) out[key] = toPdfMakeLayouts(child);
  if (out.layout && typeof out.layout === "object" && !Array.isArray(out.layout)) {
    const table = out.table as { headerRows?: number } | undefined;
    out.layout = compileLayout(out.layout as DeclaredLayout, table?.headerRows ?? 0);
  }
  return out;
}

/** A callback per declared key, and nothing for a key left out — pdfmake falls
 *  back to its own default for an absent one, so an omitted key must not become
 *  a callback returning `undefined`. */
function compileLayout(declared: DeclaredLayout, headerRows: number): Record<string, unknown> {
  const layout: Record<string, unknown> = {};
  const constant = (v: unknown) => () => v;

  if (declared.hLineWidth !== undefined) layout.hLineWidth = constant(declared.hLineWidth);
  if (declared.vLineWidth !== undefined) layout.vLineWidth = constant(declared.vLineWidth);
  if (declared.hLineColor !== undefined) layout.hLineColor = constant(declared.hLineColor);
  if (declared.vLineColor !== undefined) layout.vLineColor = constant(declared.vLineColor);
  if (declared.paddingLeft !== undefined) layout.paddingLeft = constant(declared.paddingLeft);
  if (declared.paddingRight !== undefined) layout.paddingRight = constant(declared.paddingRight);
  if (declared.paddingTop !== undefined) layout.paddingTop = constant(declared.paddingTop);
  if (declared.paddingBottom !== undefined) layout.paddingBottom = constant(declared.paddingBottom);

  const { fillColor, headerFillColor, oddRowFillColor } = declared;
  if (fillColor !== undefined || headerFillColor !== undefined || oddRowFillColor !== undefined) {
    layout.fillColor = (rowIndex: number) => {
      if (rowIndex < headerRows) return headerFillColor ?? fillColor ?? null;
      if (oddRowFillColor !== undefined && (rowIndex - headerRows) % 2 === 1) {
        return oddRowFillColor;
      }
      return fillColor ?? null;
    };
  }
  return layout;
}

/** Puts each declared family's bytes into a virtual filesystem under a name
 *  derived from the RESOURCE, the family and the face, and builds the font map
 *  pointing at them. Keyed by resource because pdfmake's virtual filesystem is
 *  process-global and merged rather than replaced: two documents declaring a
 *  family of the same name under different bytes would share one entry.
 *  A face left out falls back to `normal`, which the schema requires. */
function registerFonts(resource: DocumentResource): {
  vfs: Record<string, Uint8Array | string>;
  fonts: Record<string, Record<string, string>>;
} {
  const vfs: Record<string, Uint8Array | string> = { ...(robotoVfs as Record<string, string>) };
  const fonts: Record<string, Record<string, string>> = { Roboto: { ...ROBOTO } };

  for (const [family, faces] of Object.entries(resource.fonts ?? {})) {
    const map: Record<string, string> = {};
    for (const face of FACES) {
      const bytes = faces[face] ?? faces.normal;
      if (!(bytes instanceof Uint8Array)) {
        throw new InvokeError(
          "ERR_INVALID_FONT",
          `PdfMake.Document "${resource.metadata.name}": font '${family}.${face}' must be font file bytes ` +
            `(embed one with !include-bytes); got ${typeof bytes}.`,
        );
      }
      const file = `${resource.metadata.name}-${family}-${face}.ttf`;
      vfs[file] = bytes;
      map[face] = file;
    }
    fonts[family] = map;
  }
  return { vfs, fonts };
}

export function register(): void {}

export async function create(
  resource: DocumentResource,
  ctx: ResourceContext,
): Promise<PdfMakeDocument> {
  return new PdfMakeDocument(ctx, resource);
}
