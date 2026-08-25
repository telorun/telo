// fontkit ships no types, so they are declared beside this file. Referenced
// rather than merely present: a declaration file nothing imports is only in the
// program when a tsconfig `include` names it, and a module that DEPENDS on this
// one compiles these sources through its own tsconfig, where it is not named.
/// <reference path="./fontkit.d.ts" />
import { create as createFont, type Font } from "fontkit";
import { InvokeError, type ResourceContext, type ResourceInstance } from "@telorun/sdk";
import { estimateVertical, estimateWidth } from "./estimate.js";
import { type Face, type FamilyHandle, isFace, isFamilyHandle, selectFace } from "./face.js";

interface MeasureResource {
  metadata: { name: string; module?: string };
  family: unknown;
  size?: number;
  style?: Face;
}

interface MeasureInputs {
  strings: string[];
  size?: number;
  style?: string;
}

interface MeasureOutput {
  family: string;
  widths: number[];
  ascender: number;
  descender: number;
  lineGap: number;
  exact: boolean;
}

/**
 * Measures a batch of strings in one referenced family.
 *
 * Parsed faces are cached per face for the resource's lifetime: a face is
 * configuration, and re-parsing a megabyte of font tables per call would put
 * the whole point of batching back.
 */
class FontMeasure implements ResourceInstance<MeasureInputs, MeasureOutput> {
  private readonly parsed = new Map<Face, Font | null>();
  private family?: FamilyHandle;

  constructor(
    private readonly ctx: ResourceContext,
    private readonly resource: MeasureResource,
  ) {}

  async invoke(inputs: MeasureInputs): Promise<MeasureOutput> {
    const size = inputs.size ?? this.resource.size ?? 12;
    const style = isFace(inputs.style) ? inputs.style : (this.resource.style ?? "normal");
    const family = this.resolveFamily();
    const font = this.faceFor(family, style);

    if (!font) {
      return {
        family: family.family,
        widths: inputs.strings.map((text) => estimateWidth(text, size)),
        ...estimateVertical(size),
        exact: false,
      };
    }

    const scale = size / font.unitsPerEm;
    return {
      family: family.family,
      widths: inputs.strings.map((text) => (text === "" ? 0 : font.layout(text).advanceWidth * scale)),
      ascender: font.ascent * scale,
      // Negative in the face's own tables; a caller wants a depth, not a
      // direction, and every layout that adds it would otherwise subtract.
      descender: Math.abs(font.descent) * scale,
      lineGap: font.lineGap * scale,
      exact: true,
    };
  }

  snapshot(): Record<string, unknown> {
    return {
      family: this.resolveFamily().family,
      size: this.resource.size ?? 12,
      style: this.resource.style ?? "normal",
    };
  }

  private resolveFamily(): FamilyHandle {
    this.family ??= this.ctx.resolveRef(
      this.resource.family,
      isFamilyHandle,
      () => `Font.Measure "${this.resource.metadata.name}": 'family'`,
      "Font.Family",
    );
    return this.family;
  }

  /** The parsed face, or null when the family declared no bytes for it — which
   *  is a valid declaration, not a failure, and selects the estimate. */
  private faceFor(family: FamilyHandle, style: Face): Font | null {
    const cached = this.parsed.get(style);
    if (cached !== undefined) return cached;

    const bytes = selectFace(family.faces, style);
    let font: Font | null = null;
    if (bytes) {
      let created: unknown;
      try {
        created = createFont(bytes);
      } catch (err) {
        throw new InvokeError(
          "ERR_FONT_UNREADABLE",
          `Font.Measure "${this.resource.metadata.name}": could not read the '${style}' face of family ` +
            `'${family.family}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // A collection (.ttc / .otc) carries several faces and no metrics of its
      // own, so there is no single answer to measure with.
      if (!created || typeof (created as Font).layout !== "function") {
        throw new InvokeError(
          "ERR_FONT_UNREADABLE",
          `Font.Measure "${this.resource.metadata.name}": the '${style}' face of family '${family.family}' ` +
            `is a font collection; embed a single face instead.`,
        );
      }
      font = created as Font;
    }

    this.parsed.set(style, font);
    return font;
  }
}

export function register(): void {}

export async function create(resource: MeasureResource, ctx: ResourceContext): Promise<FontMeasure> {
  return new FontMeasure(ctx, resource);
}
