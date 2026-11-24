import { createHash } from "node:crypto";
import { InvokeError } from "@telorun/sdk";

export const PRECONDITION_FAILED = "ERR_CRUD_PRECONDITION_FAILED";

type Serializable = { toJSON(): unknown };

const hasToJSON = (value: object): value is Serializable => typeof (value as Partial<Serializable>).toJSON === "function";

/** JSON of a value as the wire writes it — a date as its ISO text, bytes as base64url, a
 *  BigInt in digits — with every object's keys in order, so one record has one text. */
function canonical(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return JSON.stringify(Buffer.from(value).toString("base64url"));
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    if (hasToJSON(value)) return canonical(value.toJSON());
    const members = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, member]) => `${JSON.stringify(name)}:${canonical(member)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The strong validator of a stored record, in the shape it is answered in. */
export function etagOf(record: Record<string, unknown>): string {
  return `"${createHash("sha256").update(canonical(record)).digest("hex")}"`;
}

/** Whether an `If-Match` header holds the record's validator: a listed strong
 *  tag equal to it, or `*`. Absent (or empty) states no precondition. */
export function preconditionHolds(ifMatch: unknown, etag: string): boolean {
  if (typeof ifMatch !== "string" || ifMatch.trim() === "") return true;
  return ifMatch.split(",").some((tag) => {
    const candidate = tag.trim();
    return candidate === "*" || candidate === etag;
  });
}

export function preconditionFailed(owner: string): InvokeError {
  return new InvokeError(
    PRECONDITION_FAILED,
    `${owner}: the record no longer matches the If-Match validator, so it was changed since it was read.`,
  );
}
