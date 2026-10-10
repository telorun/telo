import { modelResponseInvalid } from "@telorun/ai";

/**
 * How a decoded answer or stream frame is read: as untrusted.
 *
 * A member the reader walks or indexes must have its shape when it is present —
 * a list whose every element is an object, or an object — and one that does not
 * is an answer that cannot be read, raised naming the member. A leaf of the
 * wrong type is read as absent and is never copied into an answer. Absent and
 * null are the same thing: nothing was said.
 */

export type Members = Record<string, unknown>;

export const isRecord = (value: unknown): value is Members =>
  !!value && typeof value === "object" && !Array.isArray(value);

const misshapen = (label: string, member: string, shape: string): Error =>
  modelResponseInvalid(
    `${label}: the endpoint sent '${member}' in a form that cannot be read. It must be ${shape}.`,
  );

/** A member holding a list of objects, or `undefined` when it holds nothing. */
export function objectList(value: unknown, member: string, label: string): Members[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw misshapen(label, member, "a list of objects");
  }
  return value;
}

/** A member holding an object, or `undefined` when it holds nothing. */
export function objectMember(value: unknown, member: string, label: string): Members | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw misshapen(label, member, "an object");
  return value;
}

/** A text leaf, absent unless it is text. */
export const textLeaf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** A numeric leaf, absent unless it is a number. */
export const numberLeaf = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;
