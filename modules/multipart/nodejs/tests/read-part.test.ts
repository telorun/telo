import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { create } from "../src/read-part-controller.js";

const BOUNDARY = "b0undary";
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const encoder = new TextEncoder();

/** Two chunks per part — its delimiter and headers, then its content — and the
 *  closing delimiter last, so a pull count says how far the read went. */
function body(parts: Array<{ name: string; content: string }>): Uint8Array[] {
  const chunks = parts.flatMap(({ name, content }) => [
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\nContent-Type: text/plain\r\n\r\n`,
    `${content}\r\n`,
  ]);
  return [...chunks, `--${BOUNDARY}--\r\n`].map((text) => encoder.encode(text));
}

/** A source answering `chunks` one per pull, counting its pulls and whether it was released. */
function counting(chunks: Uint8Array[]) {
  const seen = { pulls: 0, released: false };
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (seen.released) throw new Error("pulled after release");
        if (seen.pulls === chunks.length) return { done: true, value: undefined };
        return { done: false, value: chunks[seen.pulls++] };
      },
      async return() {
        seen.released = true;
        return { done: true, value: undefined };
      },
    }),
  };
  return { source, seen };
}

async function readPart(input: AsyncIterable<unknown>, name: string, limits: Record<string, unknown> = {}) {
  const ctx = { log: { warn: () => undefined } } as unknown as ResourceContext;
  const instance = await create({}, ctx);
  return instance.invoke({ input: input as AsyncIterable<unknown>, contentType: CONTENT_TYPE, name, ...limits });
}

async function text(content: AsyncIterable<Uint8Array>): Promise<string> {
  let out = "";
  for await (const chunk of content) out += new TextDecoder().decode(chunk);
  return out;
}

const THREE = [
  { name: "note", content: "first" },
  { name: "file", content: "the file" },
  { name: "after", content: "never read" },
];

describe("Multipart.ReadPart", () => {
  it("never pulls the parts after the one it returns, and releases the input when it is read", async () => {
    const { source, seen } = counting(body(THREE));
    const part = await readPart(source, "file");
    expect({ name: part.name, contentType: part.contentType }).toEqual({ name: "file", contentType: "text/plain" });
    expect(await text(part.content)).toBe("the file");
    // Up to the next part's headers, where the file's content ends; never that part's content.
    expect(seen).toEqual({ pulls: 5, released: true });
  });

  it("releases the input when the content is released unread", async () => {
    const { source, seen } = counting(body(THREE));
    const part = await readPart(source, "file");
    await part.content[Symbol.asyncIterator]().return!();
    expect(seen.released).toBe(true);
  });

  it("releases the input when the content's reader stops early", async () => {
    const chunks = body([{ name: "file", content: "x".repeat(64) }, ...THREE.slice(2)]);
    const { source, seen } = counting([chunks[0], chunks[1].slice(0, 32), chunks[1].slice(32), ...chunks.slice(2)]);
    const part = await readPart(source, "file");
    for await (const chunk of part.content) {
      void chunk;
      break;
    }
    expect(seen).toEqual({ pulls: 3, released: true });
  });

  it("refuses a payload with no part of that name, naming it", async () => {
    const { source, seen } = counting(body(THREE.slice(0, 1)));
    await expect(readPart(source, "file")).rejects.toMatchObject({
      code: "ERR_MULTIPART_PART_MISSING",
      data: { name: "file" },
    });
    expect(seen.released).toBe(true);
  });

  it("rejects the call for a payload malformed before the part", async () => {
    const chunks = [encoder.encode(`--${BOUNDARY}\r\nnot a header line\r\n\r\n`), ...body(THREE).slice(1)];
    const { source, seen } = counting(chunks);
    await expect(readPart(source, "file")).rejects.toMatchObject({
      code: "ERR_MULTIPART_MALFORMED",
      data: { reason: "header-malformed" },
    });
    expect(seen.released).toBe(true);
  });

  it("fails the read of a part whose body is malformed, not the call", async () => {
    const { source, seen } = counting(body(THREE).slice(0, 4));
    const part = await readPart(source, "file");
    await expect(text(part.content)).rejects.toMatchObject({ code: "ERR_MULTIPART_MALFORMED", data: { reason: "truncated" } });
    expect(seen.released).toBe(true);
  });

  it("counts the parts it skips toward the limits", async () => {
    const parts = counting(body(THREE));
    await expect(readPart(parts.source, "after", { maxParts: 2n })).rejects.toMatchObject({
      code: "ERR_MULTIPART_LIMIT_EXCEEDED",
      data: { limit: "maxParts", max: 2 },
    });
    const bytes = counting(body(THREE));
    await expect(readPart(bytes.source, "file", { maxPartBytes: 4n })).rejects.toMatchObject({
      code: "ERR_MULTIPART_LIMIT_EXCEEDED",
      data: { limit: "maxPartBytes", part: 0, name: "note" },
    });
  });
});
