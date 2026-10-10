import { ERR_INPUT_INVALID, type ResourceContext } from "@telorun/sdk";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { create } from "../src/detector-controller.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0]);
const TEXT = new TextEncoder().encode("plain words, no signature");
const NOISE = Uint8Array.from([0x13, 0x37, 0xc0, 0xde, 0x00, 0x42, 0x99, 0x01]);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const OCTETS = "application/octet-stream";

const detector = await create({ metadata: { name: "detect" } }, {} as ResourceContext);

async function verdict(input: Uint8Array, declared?: string) {
  const { mediaType, mislabelled } = await detector.invoke({ input, declared });
  return { mediaType, mislabelled };
}

async function drain(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of content) parts.push(chunk);
  return Buffer.concat(parts);
}

/** A source of `total` one-byte chunks that counts its pulls and its release. */
function oneByteChunks(total: number) {
  const seen = { pulls: 0, released: false };
  const bytes = Uint8Array.from({ length: total }, (unused, index) => (index * 31 + 7) % 256);
  bytes.set(PNG);
  let at = 0;
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        seen.pulls++;
        return at < total
          ? { done: false, value: bytes.subarray(at, ++at) }
          : { done: true, value: undefined };
      },
      async return() {
        seen.released = true;
        return { done: true, value: undefined };
      },
    }),
  };
  return { source, bytes, seen };
}

it.each([
  ["nothing declared, bytes prove a type", PNG, undefined, "image/png", false],
  ["octet-stream declared, bytes prove a type", PNG, OCTETS, "image/png", false],
  ["nothing declared, bytes prove nothing", NOISE, undefined, OCTETS, false],
  ["the declared type is proven", PNG, "image/png", "image/png", false],
  ["the declared type's container is proven", ZIP, DOCX, DOCX, false],
  ["another type is proven", PNG, "image/jpeg", "image/png", true],
  ["a container type is declared, another type is proven", PNG, DOCX, "image/png", true],
  ["a type with a signature is declared, nothing is proven", NOISE, "image/png", OCTETS, true],
  ["a type built on a container is declared, nothing is proven", NOISE, DOCX, OCTETS, true],
  ["a type with no signature is declared, nothing is proven", TEXT, "text/plain", "text/plain", false],
  ["a type with no signature is declared, another is proven", PNG, "text/plain", "image/png", true],
])("%s", async (name, input, declared, mediaType, mislabelled) => {
  expect(await verdict(input, declared)).toEqual({ mediaType, mislabelled });
});

it("compares the declared type lower-cased and without its parameters", async () => {
  expect(await verdict(TEXT, " Text/Plain ; charset=UTF-8")).toEqual({
    mediaType: "text/plain",
    mislabelled: false,
  });
});

it("recognises exactly the nine types of the data file", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../../media-types.json", import.meta.url), "utf8"),
  );
  expect(catalog.types.map((entry: { mediaType: string }) => entry.mediaType)).toEqual([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "application/zip",
    DOCX,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ]);
});

it("reads 4,096 one-byte chunks before returning, then yields every byte unchanged", async () => {
  const { source, bytes, seen } = oneByteChunks(10_000);

  const result = await detector.invoke({ input: source, declared: "image/png" });

  expect(seen.pulls).toBe(4096);
  expect(result.mediaType).toBe("image/png");
  expect(Buffer.compare(await drain(result.output), bytes)).toBe(0);
});

it("yields bytes held whole as they were given", async () => {
  const input = Uint8Array.from({ length: 9000 }, (unused, index) => index % 251);
  const result = await detector.invoke({ input });
  expect(Buffer.compare(await drain(result.output), input)).toBe(0);
});

it("releases the source when the output is dropped before it is read", async () => {
  const { source, seen } = oneByteChunks(10_000);
  const result = await detector.invoke({ input: source });

  await result.output[Symbol.asyncIterator]().return?.();

  expect(seen.released).toBe(true);
});

it("releases the source when the consumer stops part-way", async () => {
  const { source, seen } = oneByteChunks(10_000);
  const result = await detector.invoke({ input: source });

  let taken = 0;
  for await (const chunk of result.output) if (++taken === 5000) break;

  expect(seen).toEqual({ pulls: 5000, released: true });
});

it("rethrows a source failure as raised, while reading the leading bytes and after", async () => {
  const failure = Object.assign(new Error("the upload was cancelled"), { code: "SOURCE_BROKE" });
  async function* failingAfter(chunks: number): AsyncIterable<Uint8Array> {
    for (let index = 0; index < chunks; index++) yield new Uint8Array(4096);
    throw failure;
  }

  await expect(detector.invoke({ input: failingAfter(0) })).rejects.toBe(failure);

  const result = await detector.invoke({ input: failingAfter(2) });
  await expect(drain(result.output)).rejects.toBe(failure);
});

it("refuses a value that is neither bytes nor a stream under the input contract's code", async () => {
  await expect(detector.invoke({ input: { not: "bytes" } })).rejects.toMatchObject({
    code: ERR_INPUT_INVALID,
    data: { issues: [{ path: "input" }] },
  });
});

it("refuses a chunk that is not bytes and releases the source, in the window and past it", async () => {
  const seen = { released: 0 };
  function yielding(...values: unknown[]): AsyncIterable<unknown> {
    let at = 0;
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          at < values.length
            ? { done: false, value: values[at++] }
            : { done: true, value: undefined },
        return: async () => {
          seen.released++;
          return { done: true, value: undefined };
        },
      }),
    };
  }
  const refusal = { code: ERR_INPUT_INVALID, data: { issues: [{ path: "input" }] } };

  await expect(detector.invoke({ input: yielding("text") })).rejects.toMatchObject(refusal);
  expect(seen.released).toBe(1);

  const result = await detector.invoke({ input: yielding(new Uint8Array(4096), "text") });
  await expect(drain(result.output)).rejects.toMatchObject(refusal);
  expect(seen.released).toBe(2);
});

it.each(["", "png", "a/b/c"])("reads a declared %j as no claim", async (declared) => {
  expect(await verdict(PNG, declared)).toEqual({ mediaType: "image/png", mislabelled: false });
  expect(await verdict(NOISE, declared)).toEqual({ mediaType: OCTETS, mislabelled: false });
});

it("holds its media type output to the pattern the blob module uses, character for character", async () => {
  const pattern = "^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$";
  const quoted = `pattern: "${pattern}"`;
  const own = await readFile(new URL("../../telo.yaml", import.meta.url), "utf8");
  const blob = await readFile(new URL("../../../blob/telo.yaml", import.meta.url), "utf8");

  expect(own.split(quoted).length - 1).toBe(1);
  expect(blob.split(quoted).length - 1).toBe(4);
  // Every lower-case media-type pattern in either file is that one.
  const lowerCasePatterns = (text: string) =>
    [...text.matchAll(/pattern: "(\^\[a-z0-9\][^"]*)"/g)].map((match) => match[1]);
  expect(new Set([...lowerCasePatterns(own), ...lowerCasePatterns(blob)])).toEqual(
    new Set([pattern]),
  );
});
