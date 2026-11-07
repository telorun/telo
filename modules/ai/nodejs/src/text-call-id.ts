import { createHash } from "node:crypto";
import { toPlainJson } from "@telorun/sdk";

/**
 * A text call's id is a content address, so a resumed run rebuilds it from the
 * recorded conversation alone: `block_` + a name-based UUIDv8 over SHA-256
 * (RFC 9562 §B.2) of the RFC 8785 canonical JSON of what the call is.
 */

/** The namespace every text call's name is hashed under. */
const TEXT_CALL_NAMESPACE = Buffer.from("9f3c6a2e8b1d4e7f8a05c2d16b4e9a73", "hex");

/** What identifies one text call. */
export interface TextCallIdentity {
  /** The assistant message's recorded text. */
  text: string;
  /** The advertised tool name. */
  tool: string;
  /** The entry's tags; sorted here. */
  tags: readonly string[];
  /** The evaluated arguments, or `null` when evaluation failed. */
  arguments: unknown;
}

/** RFC 8785 (JCS) canonical JSON of a plain JSON value. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`canonical JSON cannot hold the number ${value}`);
      }
      return JSON.stringify(value);
    case "bigint":
      return value.toString();
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      // Keys sorted by UTF-16 code units, which is the default string order.
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonical JSON cannot hold a ${typeof value}`);
  }
}

/** The id of a text call. */
export function textCallId(identity: TextCallIdentity): string {
  const name = canonicalJson({
    text: identity.text,
    tool: identity.tool,
    tags: [...identity.tags].sort(),
    arguments: identity.arguments === null ? null : toPlainJson(identity.arguments),
  });
  const bytes = createHash("sha256")
    .update(TEXT_CALL_NAMESPACE)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `block_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
