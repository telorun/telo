import { createHash } from "node:crypto";
import { InvokeError } from "@telorun/sdk";

/**
 * The cursor a paged operation hands out, and the only part of paging `graph`
 * owns: an opaque envelope around the backend's own tail. The envelope carries
 * a version and a digest of what the page was asked of — the operation kind, the
 * type, the endpoint filters, the canonical `where` — so a cursor resumes only
 * the listing that produced it. What the tail holds is the backend's business.
 */

const ENVELOPE_VERSION = 1;

/** What a cursor is bound to. Any plain value; compared by canonical digest. */
export type CursorBinding = Readonly<Record<string, unknown>>;

interface Envelope {
  readonly v: number;
  readonly b: string;
  readonly t: string;
}

/** One rendering per value, whatever order its keys were written in and
 *  whichever of CEL's or the host's integer forms it arrived as. */
function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return { $int: value.toString() };
  if (typeof value === "number") return Number.isInteger(value) ? { $int: String(value) } : value;
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64url") };
  if (value instanceof Date) return { $time: value.toISOString() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, member]) => [key, canonical(member)]),
    );
  }
  return value ?? null;
}

/** `where` with nothing in it that filters nothing: an operator holding no
 *  property is the same listing as the operator left out. */
export function canonicalWhere(where: Record<string, unknown>): unknown {
  return canonical(
    Object.fromEntries(
      Object.entries(where).filter(
        ([, operands]) =>
          operands !== undefined &&
          operands !== null &&
          Object.values(operands as Record<string, unknown>).some((v) => v !== undefined),
      ),
    ),
  );
}

function digest(binding: CursorBinding): string {
  return createHash("sha256").update(JSON.stringify(canonical(binding))).digest("base64url");
}

export function encodeCursor(binding: CursorBinding, tail: string): string {
  const envelope: Envelope = { v: ENVELOPE_VERSION, b: digest(binding), t: tail };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function cursorInvalid(describe: string, reason: string): never {
  throw new InvokeError(
    "GRAPH_CURSOR_INVALID",
    `GRAPH_CURSOR_INVALID: ${describe}: 'cursor' ${reason}. A cursor is the 'next' of an earlier ` +
      `page of the same operation, type and filter, passed back unchanged.`,
  );
}

function readEnvelope(cursor: string): Envelope | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const envelope = parsed as Partial<Envelope> | null;
  if (
    !envelope ||
    typeof envelope !== "object" ||
    typeof envelope.v !== "number" ||
    typeof envelope.b !== "string" ||
    typeof envelope.t !== "string"
  ) {
    return undefined;
  }
  return envelope as Envelope;
}

/** The backend's tail a cursor carries, once it is known to be this listing's. */
export function decodeCursor(describe: string, binding: CursorBinding, cursor: unknown): string {
  if (typeof cursor !== "string") cursorInvalid(describe, "is not a string");
  const envelope = readEnvelope(cursor);
  if (!envelope) cursorInvalid(describe, "is malformed");
  if (envelope.v !== ENVELOPE_VERSION) {
    cursorInvalid(describe, `has envelope version ${envelope.v}, which this runtime does not read`);
  }
  if (envelope.b !== digest(binding)) {
    cursorInvalid(describe, "was issued for another operation, type or filter");
  }
  return envelope.t;
}
