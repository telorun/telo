/**
 * fontkit ships no type declarations, so the surface this module uses is
 * declared here — the same arrangement `modules/pdfmake` uses for pdfmake.
 *
 * Deliberately narrow: only the members the measurement path reads. Anything
 * broader would be a second, unverified copy of someone else's API.
 */
declare module "fontkit" {
  /** A shaped run of text. `advanceWidth` is in font design units. */
  interface GlyphRun {
    advanceWidth: number;
  }

  interface Font {
    /** Design units per em — the divisor that turns design units into points. */
    unitsPerEm: number;
    ascent: number;
    /** Negative in every well-formed face. */
    descent: number;
    lineGap: number;
    familyName?: string;
    layout(text: string): GlyphRun;
  }

  /** A `.ttc` / `.otc` collection has no metrics of its own. */
  interface FontCollection {
    fonts: Font[];
  }

  export function create(buffer: Uint8Array, postscriptName?: string): Font | FontCollection;
}
