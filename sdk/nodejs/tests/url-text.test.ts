/**
 * `url-text` — the plain encoding of `Telo.Url`. The vectors are read from the JSON beside
 * the value-type entries, which the Rust SDK runs too, so both codecs read, write and build
 * every row the same way.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLAIN_ENCODINGS } from "../src/plain-encoding.js";
import { toPlainJson } from "../src/plain-json.js";
import { composeUrl, readUrlText, writeUrlText, type UrlValue } from "../src/url-text.js";

interface DecodeVector {
  readonly text: string;
  readonly members?: Record<string, unknown>;
  readonly canonical?: string;
  readonly refusal?: string;
}
interface ComposeVector {
  readonly members: Record<string, unknown>;
  readonly canonical?: string;
  readonly refusal?: string;
}

const vectors = JSON.parse(
  readFileSync(new URL("../../value-types/encodings/url-text.json", import.meta.url), "utf8"),
) as { decode: DecodeVector[]; compose: ComposeVector[] };

/** A value's members as the vectors write them: a port as a number, the query as an object. */
function membersOf(value: UrlValue): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, held] of Object.entries(value)) {
    out[key] = typeof held === "bigint" ? Number(held) : key === "query" ? { ...(held as object) } : held;
  }
  return out;
}

describe("url-text vectors", () => {
  it.each(vectors.decode)("reads $text", ({ text, members, canonical, refusal }) => {
    const read = readUrlText(text);
    if (refusal !== undefined) {
      expect(read).toEqual({ refusal });
      expect(PLAIN_ENCODINGS["url-text"]!.decode(text)).toBeUndefined();
      return;
    }
    if (!("value" in read)) throw new Error(read.refusal);
    expect(membersOf(read.value)).toEqual(members);
    expect(writeUrlText(read.value)).toBe(canonical);
    expect(readUrlText(canonical!)).toEqual(read);
  });

  it.each(vectors.compose)("builds $members", ({ members, canonical, refusal }) => {
    const built = composeUrl(members);
    if (refusal !== undefined) {
      expect(built).toEqual({ refusal });
      return;
    }
    if (!("value" in built)) throw new Error(built.refusal);
    expect(writeUrlText(built.value)).toBe(canonical);
  });
});

describe("a URL value", () => {
  it("is its whole text to a reader outside Telo, its password included, and frozen", () => {
    const { value } = composeUrl({ scheme: "https", host: "example.com", user: "app", password: "p w", path: "/a b" }) as {
      value: UrlValue;
    };
    // A transport body is not an observability writer: the value crosses it intact.
    expect(toPlainJson({ address: value })).toEqual({ address: "https://app:p%20w@example.com/a%20b" });
    expect(Object.isFrozen(value)).toBe(true);
  });
});
