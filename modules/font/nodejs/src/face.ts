/**
 * The face vocabulary and the fallback chain, shared by both controllers.
 *
 * A face left out falls back to `normal`, and a family may declare no faces at
 * all — identity without bytes, which is a valid declaration of a typeface the
 * renderer already has.
 */

export const FACES = ["normal", "bold", "italic", "boldItalic"] as const;

export type Face = (typeof FACES)[number];

export type Faces = Partial<Record<Face, Uint8Array>>;

export function isFace(value: unknown): value is Face {
  return typeof value === "string" && (FACES as readonly string[]).includes(value);
}

/** The bytes to measure or embed for `face`, falling back to `normal`. */
export function selectFace(faces: Faces, face: Face): Uint8Array | undefined {
  return faces[face] ?? faces.normal;
}

/** The shape a consumer duck-types a `Font.Family` instance against.
 *
 *  A consumer reaches this through the module's `exports.code:` entry — one
 *  module scope across every dependent, rather than a copy inlined into each of
 *  their bundles — so it gets the type AND the guard rather than restating the
 *  two fields and hoping they stay in step. It stays a structural check because
 *  what arrives is an instance the kernel injected, not one this code built. */
export interface FamilyHandle {
  readonly family: string;
  readonly faces: Faces;
}

export function isFamilyHandle(value: unknown): value is FamilyHandle {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<FamilyHandle>;
  return typeof candidate.family === "string" && typeof candidate.faces === "object";
}
