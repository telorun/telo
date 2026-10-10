import catalog from "../../media-types.json" with { type: "json" };

/** One run of bytes a signature expects at an offset. */
interface SignaturePart {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** A type the leading bytes can prove: any one alternative, every part of it. */
interface ProvableType {
  readonly mediaType: string;
  readonly alternatives: readonly (readonly SignaturePart[])[];
}

interface CatalogEntry {
  mediaType: string;
  signatures?: { offset: number; hex: string }[][];
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
            parts.map(({ offset, hex }) => ({ offset, bytes: Buffer.from(hex, "hex") })),
          ),
        },
      ],
);

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

function holds(leading: Uint8Array, part: SignaturePart): boolean {
  if (leading.byteLength < part.offset + part.bytes.byteLength) return false;
  return part.bytes.every((byte, index) => leading[part.offset + index] === byte);
}
