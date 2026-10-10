import {
  ERR_INPUT_INVALID,
  NOOP_LOGGER,
  type InvokeContext,
  type ResourceContext,
} from "@telorun/sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import * as Delete from "../src/delete-controller.js";
import * as Get from "../src/get-controller.js";
import * as Head from "../src/head-controller.js";
import { MEDIA_TYPE } from "../src/operation-binding.js";
import * as Put from "../src/put-controller.js";

/** Resolves a slot the way the kernel does: the guard decides. */
const ctx = {
  log: NOOP_LOGGER,
  resolveRef(value: unknown, guard: (candidate: unknown) => boolean, describe: () => string) {
    if (!guard(value)) throw new Error(`${describe()} is not a store`);
    return value;
  },
} as unknown as ResourceContext;

const invocation = { cancellation: {} } as unknown as InvokeContext;
const bytes = (text: string) => new TextEncoder().encode(text);

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield bytes(part);
}

async function drain(content: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of content) text += new TextDecoder().decode(chunk);
  return text;
}

/** A source of `chunks` that records how it was read. */
function source(items: unknown[]) {
  const seen = { pulled: 0, released: false };
  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (seen.pulled < items.length) return { done: false, value: items[seen.pulled++] };
        return { done: true, value: undefined };
      },
      async return() {
        seen.released = true;
        return { done: true, value: undefined };
      },
    }),
  };
  return { iterable, seen };
}

/**
 * A store that is a plain object — no class, nothing imported from the module —
 * and does nothing but drain: a put is recorded only once its source has ended.
 */
function plainStore(answers: { get?: unknown; head?: unknown } = {}) {
  const calls: unknown[][] = [];
  const store = {
    async put(key: string, content: AsyncIterable<Uint8Array>, options: unknown, context: unknown) {
      calls.push(["put", key, await drain(content), options, context]);
    },
    async get(key: string, context: unknown) {
      calls.push(["get", key, context]);
      return answers.get ?? { status: "absent" };
    },
    async head(key: string, context: unknown) {
      calls.push(["head", key, context]);
      return answers.head ?? { status: "absent" };
    },
    async delete(key: string, context: unknown) {
      calls.push(["delete", key, context]);
    },
  };
  return { store, calls };
}

const resource = (store: unknown) => ({ metadata: { name: "op" }, store }) as never;

it("puts a stream through a store recognised by its methods alone, counting and hashing it itself", async () => {
  const { store, calls } = plainStore();
  const put = await Put.create(resource(store), ctx);

  const result = await put.invoke(
    { key: "a/b.txt", content: chunks("hello ", "world"), contentType: "text/plain", maxBytes: 11n },
    invocation,
  );

  expect(result).toEqual({
    key: "a/b.txt",
    size: 11,
    sha256: createHash("sha256").update("hello world").digest("hex"),
    contentType: "text/plain",
  });
  expect(calls).toEqual([
    ["put", "a/b.txt", "hello world", { contentType: "text/plain" }, invocation],
  ]);
});

it("refuses a slot value missing one of the four methods", async () => {
  const { store } = plainStore();
  const put = await Put.create(resource({ ...store, head: undefined }), ctx);

  await expect(
    put.invoke({ key: "a", content: bytes("x"), contentType: "text/plain" }),
  ).rejects.toThrow(`Blob.Put "op": 'store' is not a store`);
});

it("fails the store's source on the chunk that crosses maxBytes, pulling one chunk past the bound", async () => {
  const { store, calls } = plainStore();
  const put = await Put.create(resource(store), ctx);
  const chunk = new Uint8Array(10);
  const over = source([chunk, chunk, chunk, chunk, chunk, chunk]);

  await expect(
    put.invoke({ key: "a", content: over.iterable, contentType: "text/plain", maxBytes: 25 }),
  ).rejects.toMatchObject({ code: "ERR_BLOB_TOO_LARGE", data: { key: "a", maxBytes: 25 } });
  expect(over.seen).toEqual({ pulled: 3, released: true });
  expect(calls).toEqual([]);
});

it("refuses bytes over maxBytes without calling the store", async () => {
  let called = false;
  const { store } = plainStore();
  const put = await Put.create(
    resource({ ...store, put: async () => void (called = true) }),
    ctx,
  );

  await expect(
    put.invoke({ key: "a", content: bytes("12345"), contentType: "text/plain", maxBytes: 4 }),
  ).rejects.toMatchObject({ code: "ERR_BLOB_TOO_LARGE", data: { key: "a", maxBytes: 4 } });
  expect(called).toBe(false);
});

it("refuses a stream that yields a string with ERR_INPUT_INVALID, storing nothing", async () => {
  const { store, calls } = plainStore();
  const put = await Put.create(resource(store), ctx);
  const mixed = source([bytes("ok"), "text"]);

  await expect(
    put.invoke({ key: "a", content: mixed.iterable, contentType: "text/plain" }),
  ).rejects.toMatchObject({
    code: ERR_INPUT_INVALID,
    data: { issues: [{ path: "content" }] },
  });
  expect(mixed.seen.released).toBe(true);
  expect(calls).toEqual([]);
});

it("passes a source failure through a put as it was raised", async () => {
  const { store } = plainStore();
  const put = await Put.create(resource(store), ctx);
  const failure = new Error("upstream broke");
  async function* failing(): AsyncIterable<Uint8Array> {
    yield bytes("partial");
    throw failure;
  }

  await expect(
    put.invoke({ key: "a", content: failing(), contentType: "text/plain" }),
  ).rejects.toBe(failure);
});

/** A source that counts every pull and every release. */
function counted(items: unknown[]) {
  const seen = { pulls: 0, releases: 0 };
  const iterable: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (seen.pulls < items.length) return { done: false, value: items[seen.pulls++] };
        seen.pulls += 1;
        return { done: true, value: undefined };
      },
      async return() {
        seen.releases += 1;
        return { done: true, value: undefined };
      },
    }),
  };
  return { iterable, seen };
}

it.each([
  ["and leaves the source alone", async () => {}],
  [
    "after releasing what it was handed itself",
    async (content: AsyncIterable<Uint8Array>) => {
      await content[Symbol.asyncIterator]().return?.();
    },
  ],
])("releases a source exactly once, unpulled, when the store fails before its first pull %s", async (name, before) => {
  const failure = new Error("the upload could not be created");
  const { store } = plainStore();
  const failing = {
    ...store,
    async put(key: string, content: AsyncIterable<Uint8Array>) {
      await before(content);
      throw failure;
    },
  };
  const put = await Put.create(resource(failing), ctx);
  const unread = counted([bytes("never read")]);

  await expect(
    put.invoke({ key: "a", content: unread.iterable, contentType: "text/plain" }),
  ).rejects.toBe(failure);
  expect(unread.seen).toEqual({ pulls: 0, releases: 1 });
});

it("does not release a source that ended", async () => {
  const { store } = plainStore();
  const put = await Put.create(resource(store), ctx);
  const whole = counted([bytes("all of it")]);

  await put.invoke({ key: "a", content: whole.iterable, contentType: "text/plain" });

  expect(whole.seen).toEqual({ pulls: 2, releases: 0 });
});

it("gets a found blob as a stream with its size and media type", async () => {
  const { store, calls } = plainStore({
    get: { status: "found", size: 5, contentType: "text/plain", content: chunks("he", "llo") },
  });
  const get = await Get.create(resource(store), ctx);

  const result = await get.invoke({ key: "a", maxBytes: 5 }, invocation);

  expect({ size: result.size, contentType: result.contentType }).toEqual({
    size: 5,
    contentType: "text/plain",
  });
  expect(await drain(result.output)).toBe("hello");
  expect(calls).toEqual([["get", "a", invocation]]);
});

it("refuses a get over maxBytes from the reported size, releasing the content unread", async () => {
  const content = source([bytes("123456789")]);
  const { store } = plainStore({
    get: { status: "found", size: 9, contentType: "text/plain", content: content.iterable },
  });
  const get = await Get.create(resource(store), ctx);

  await expect(get.invoke({ key: "big", maxBytes: 8 })).rejects.toMatchObject({
    code: "ERR_BLOB_TOO_LARGE",
    data: { key: "big", size: 9, maxBytes: 8 },
  });
  expect(content.seen).toEqual({ pulled: 0, released: true });
});

it("reports an absent blob as ERR_BLOB_NOT_FOUND from get and head", async () => {
  const expected = { code: "ERR_BLOB_NOT_FOUND", data: { key: "gone" } };
  const get = await Get.create(resource(plainStore().store), ctx);
  await expect(get.invoke({ key: "gone" })).rejects.toMatchObject(expected);

  const head = await Head.create(resource(plainStore().store), ctx);
  await expect(head.invoke({ key: "gone" })).rejects.toMatchObject(expected);
});

it("reduces what a store recorded as the media type to the one vocabulary", async () => {
  const headOf = async (contentType: string) => {
    const { store } = plainStore({ head: { status: "found", size: 7, contentType } });
    return (await Head.create(resource(store), ctx)).invoke({ key: "a" }, invocation);
  };

  expect(await headOf("Text/HTML; charset=utf-8")).toEqual({ size: 7, contentType: "text/html" });
  expect(await headOf("garbage")).toEqual({ size: 7, contentType: "application/octet-stream" });
});

it("deletes through the store and returns the key", async () => {
  const { store, calls } = plainStore();
  const remove = await Delete.create(resource(store), ctx);

  expect(await remove.invoke({ key: "a/b" }, invocation)).toEqual({ key: "a/b" });
  expect(calls).toEqual([["delete", "a/b", invocation]]);
});

it("reduces with the grammar the manifest declares on its four contentType properties", () => {
  const manifest = readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8");
  const declared = [...manifest.matchAll(/pattern: "(\^\[a-z0-9\][^"]*)"/g)].map((m) => m[1]);
  const grammar = MEDIA_TYPE.source.replaceAll("\\/", "/");

  expect(declared).toEqual([grammar, grammar, grammar, grammar]);
});
