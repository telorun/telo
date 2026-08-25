import type { ResourceInstance } from "@telorun/sdk";
import { FACES, type Face, type Faces } from "./face.js";

interface FamilyResource {
  metadata: { name: string; module?: string };
  family: string;
  faces?: Faces;
}

/**
 * One declared typeface. Holds the family name and whatever face bytes were
 * embedded, and hands both to whoever references it — a document embedding the
 * font, a page serving it, `Font.Measure` measuring in it.
 *
 * A provider, not an operation: this is configuration a consumer reads, and the
 * bytes are the same bytes for the process lifetime.
 */
class FontFamily implements ResourceInstance {
  readonly family: string;
  readonly faces: Faces;

  constructor(resource: FamilyResource) {
    this.family = resource.family;
    this.faces = resource.faces ?? {};
  }

  async provide(): Promise<this> {
    return this;
  }

  /** Configured state: the name renderers select by, and which faces were
   *  declared — the latter is what tells a reader whether text measured against
   *  this family is exact or estimated. */
  snapshot(): Record<string, unknown> {
    return {
      family: this.family,
      faces: FACES.filter((face: Face) => this.faces[face] !== undefined),
    };
  }
}

export function register(): void {}

export async function create(resource: FamilyResource): Promise<FontFamily> {
  return new FontFamily(resource);
}
