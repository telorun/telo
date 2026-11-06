import catalog from "../../media-types.json" with { type: "json" };

/** One run of bytes a signature expects: at one offset, or anywhere inside a
 *  window `[start, end)` of the leading bytes. */
interface SignaturePart {
  readonly start: number;
  readonly end: number;
  readonly bytes: Uint8Array;
}

/** A type the leading bytes can prove: any one alternative, every part of it. */
interface ProvableType {
  readonly mediaType: string;
  readonly alternatives: readonly (readonly SignaturePart[])[];
}

interface CatalogEntry {
  mediaType: string;
  signatures?: { offset?: number; within?: number[]; hex: string }[][];
  container?: string;
}

const entries: CatalogEntry[] = catalog.types;

/** How many leading bytes are inspected, at most. */
export const WINDOW: number = catalog.window;

/** The type reported when the bytes prove nothing and nothing else is known. */
export const UNKNOWN: string = catalog.unknown;

export const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const provable: ProvableType[] = entries.flatMap((entry) =>
  entry.signatures === undefined
    ? []
    : [
        {
          mediaType: entry.mediaType,
          alternatives: entry.signatures.map((parts) =>
            parts.map((part) => signaturePart(entry.mediaType, part)),
          ),
        },
      ],
);

/** Reads one data-file run; a run with both or neither of `offset` and `within`,
 *  or a malformed window, is a defect in the data file and fails at load. */
function signaturePart(
  mediaType: string,
  { offset, within, hex }: { offset?: number; within?: number[]; hex: string },
): SignaturePart {
  const bytes = Buffer.from(hex, "hex");
  const where = `media-types.json: ${mediaType}`;
  if (bytes.byteLength === 0 || bytes.byteLength * 2 !== hex.length) {
    throw new Error(`${where}: "hex" must be a non-empty run of whole bytes`);
  }
  if ((offset === undefined) === (within === undefined)) {
    throw new Error(`${where}: a run declares exactly one of "offset" and "within"`);
  }
  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`${where}: "offset" must be a non-negative integer`);
    }
    return { start: offset, end: offset + bytes.byteLength, bytes };
  }
  const [start, end] = within!;
  if (
    within!.length !== 2 ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end - start < bytes.byteLength
  ) {
    throw new Error(`${where}: "within" must be [start, end] with room for the run`);
  }
  if (end > WINDOW) throw new Error(`${where}: "within" reaches past the ${WINDOW}-byte window`);
  return { start, end, bytes };
}

/** A recognised type → the type whose signature vouches for it: itself, or the
 *  container it is built on. */
const vouchedBy = new Map<string, string>(
  entries.map((entry) => [entry.mediaType, entry.container ?? entry.mediaType]),
);

export interface Detection {
  mediaType: string;
  mislabelled: boolean;
}

/** The type the leading bytes prove, if any. */
export function provenType(leading: Uint8Array): string | undefined {
  return provable.find(({ alternatives }) =>
    alternatives.some((parts) => parts.every((part) => holds(leading, part))),
  )?.mediaType;
}

/** A declared media type as it is compared: parameters dropped, lower-cased.
 *  `undefined` when what is left is not a media type. */
function comparableType(declared: string): string | undefined {
  const bare = declared.split(";", 1)[0].trim().toLowerCase();
  return MEDIA_TYPE.test(bare) ? bare : undefined;
}

/** The rule: what the bytes prove against what was declared. A declaration
 *  that is not a media type claims nothing. */
export function detect(leading: Uint8Array, claim: string | undefined): Detection {
  const proven = provenType(leading);
  const declared = claim === undefined ? undefined : comparableType(claim);
  if (declared === undefined || declared === UNKNOWN) {
    return { mediaType: proven ?? UNKNOWN, mislabelled: false };
  }
  const voucher = vouchedBy.get(declared);
  if (proven === undefined) {
    // A declared type the set could have proven, and did not.
    return voucher === undefined
      ? { mediaType: declared, mislabelled: false }
      : { mediaType: UNKNOWN, mislabelled: true };
  }
  return proven === voucher
    ? { mediaType: declared, mislabelled: false }
    : { mediaType: proven, mislabelled: true };
}

function holds(leading: Uint8Array, { start, end, bytes }: SignaturePart): boolean {
  const last = Math.min(end, leading.byteLength) - bytes.byteLength;
  for (let at = start; at <= last; at++) {
    if (bytes.every((byte, index) => leading[at + index] === byte)) return true;
  }
  return false;
}
