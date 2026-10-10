import { Put } from "@telorun/blob";
import type { ResourceContext } from "@telorun/sdk";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "../src/store-controller.js";

const ctx = { log: { warn: () => {} } } as unknown as ResourceContext;

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield bytes(part);
}

async function drain(content: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of content) text += new TextDecoder().decode(chunk);
  return text;
}

/** Every file beneath the root, as root-relative POSIX paths. */
async function files(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(...(await files(path.join(dir, entry.name), `${relative}/`)));
    else found.push(relative);
  }
  return found.sort();
}

function blobFile(key: string): string {
  const hash = sha256(key);
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash.slice(4)}`;
}

let root: string;
let store: Awaited<ReturnType<typeof create>>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "telo-blob-fs-"));
  store = await create({ metadata: { name: "store" }, root }, ctx);
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

async function read(key: string): Promise<string> {
  const outcome = await store.get(key);
  if (outcome.status !== "found") throw new Error(`'${key}' is ${outcome.status}`);
  return drain(outcome.content);
}

it("keeps a blob as one file at the hash of its key: a header line, then the content", async () => {
  await store.put("docs/a.txt", chunks("hello ", "world"), { contentType: "text/plain" });

  expect(await files(root)).toEqual([blobFile("docs/a.txt")]);
  expect(await readFile(path.join(root, blobFile("docs/a.txt")), "utf8")).toBe(
    '{"v":1,"key":"docs/a.txt","contentType":"text/plain"}\nhello world',
  );
  expect(await store.head("docs/a.txt")).toEqual({
    status: "found",
    size: 11,
    contentType: "text/plain",
  });
});

it("stages a put under .tmp and commits it with the rename", async () => {
  await store.put("k", chunks("old"), { contentType: "text/plain" });
  const during: { staged: string[]; visible: string }[] = [];
  async function* observed(): AsyncIterable<Uint8Array> {
    yield bytes("new ");
    during.push({ staged: await readdir(path.join(root, ".tmp")), visible: await read("k") });
    yield bytes("content");
  }

  await store.put("k", observed(), { contentType: "text/plain" });

  expect(during).toHaveLength(1);
  expect(during[0].visible).toBe("old");
  expect(during[0].staged).toHaveLength(1);
  expect(during[0].staged[0]).toMatch(/^[0-9a-f]{32}$/);
  expect(await readdir(path.join(root, ".tmp"))).toEqual([]);
  expect(await read("k")).toBe("new content");
});

it("leaves one whole blob when two puts to one key interleave", async () => {
  const left = "L".repeat(50_000);
  const right = "R".repeat(70_000);
  async function* slowly(text: string): AsyncIterable<Uint8Array> {
    for (let at = 0; at < text.length; at += 1000) {
      yield bytes(text.slice(at, at + 1000));
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  await Promise.all([
    store.put("raced", slowly(left), { contentType: "text/plain" }),
    store.put("raced", slowly(right), { contentType: "text/plain" }),
  ]);

  expect([left, right]).toContain(await read("raced"));
  expect(await files(root)).toEqual([blobFile("raced")]);
});

it("keeps the old blob byte for byte when an overwrite's source fails, and rethrows the failure", async () => {
  await store.put("k", chunks("previous"), { contentType: "text/plain" });
  const before = await readFile(path.join(root, blobFile("k")));
  const failure = new Error("upstream broke");
  async function* failing(): AsyncIterable<Uint8Array> {
    yield bytes("partial");
    throw failure;
  }

  await expect(store.put("k", failing(), { contentType: "image/png" })).rejects.toBe(failure);

  expect(await readFile(path.join(root, blobFile("k")))).toEqual(before);
  expect(await files(root)).toEqual([blobFile("k")]);
});

it("removes staging entries untouched for 24 hours after a successful put, and no younger one", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
  for (const [name, age] of [["stale", 25], ["recent", 23]] as const) {
    await writeFile(path.join(root, ".tmp", name), "abandoned");
    await utimes(path.join(root, ".tmp", name), hoursAgo(age), hoursAgo(age));
  }

  await store.put("k", chunks("x"), { contentType: "text/plain" });

  expect(await readdir(path.join(root, ".tmp"))).toEqual(["recent"]);
});

it("sweeps on a store's first put and then not again until an hour has passed", async () => {
  const plantStale = async (name: string) => {
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await writeFile(path.join(root, ".tmp", name), "abandoned");
    await utimes(path.join(root, ".tmp", name), dayAgo, dayAgo);
  };
  await store.put("k", chunks("first"), { contentType: "text/plain" });
  await plantStale("after-first-put");

  await store.put("k", chunks("second"), { contentType: "text/plain" });
  expect(await readdir(path.join(root, ".tmp"))).toEqual(["after-first-put"]);

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60 * 60 * 1000);
  await store.put("k", chunks("an hour on"), { contentType: "text/plain" });
  expect(await readdir(path.join(root, ".tmp"))).toEqual([]);
});

it("fails a put whose staging file was removed, saying so, and keeps the old blob byte for byte", async () => {
  await store.put("k", chunks("previous"), { contentType: "text/plain" });
  const before = await readFile(path.join(root, blobFile("k")));
  async function* swept(): AsyncIterable<Uint8Array> {
    yield bytes("partial");
    for (const name of await readdir(path.join(root, ".tmp"))) {
      await rm(path.join(root, ".tmp", name));
    }
    yield bytes(" rest");
  }

  await expect(store.put("k", swept(), { contentType: "text/plain" })).rejects.toThrow(
    "BlobFs.Store: the staging file for 'k' was removed before the put finished — " +
      "a put that writes nothing for 24 hours is taken for abandoned; nothing was stored.",
  );
  expect(await readFile(path.join(root, blobFile("k")))).toEqual(before);
});

it("releases a put's source once, unpulled, when the root cannot be written", async () => {
  await writeFile(path.join(root, "file"), "in the way");
  const sealed = await create({ metadata: { name: "sealed" }, root: path.join(root, "file", "store") }, ctx);
  const operationCtx = {
    log: { warn: () => {} },
    resolveRef: (value: unknown) => value,
  } as unknown as ResourceContext;
  const put = await Put.create({ metadata: { name: "put" }, store: sealed } as never, operationCtx);
  const seen = { pulls: 0, releases: 0 };
  const content: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        seen.pulls += 1;
        return { done: true, value: undefined };
      },
      async return() {
        seen.releases += 1;
        return { done: true, value: undefined };
      },
    }),
  };

  await expect(put.invoke({ key: "k", content, contentType: "text/plain" })).rejects.toMatchObject({
    code: "ENOTDIR",
  });
  expect(seen).toEqual({ pulls: 0, releases: 1 });
});

it.skipIf(!existsSync("/proc/self/fd"))("leaves no file open for content that is never pulled", async () => {
  await store.put("k", chunks("123456789"), { contentType: "text/plain" });
  const open = () => readdirSync("/proc/self/fd").length;
  const before = open();

  const found = [];
  for (let i = 0; i < 100; i++) found.push(await store.get("k"));

  expect(found.every((outcome) => outcome.status === "found")).toBe(true);
  expect(open()).toBe(before);
});

it("fails the first pull, naming the key, when the blob was replaced by one of another size", async () => {
  await store.put("k", chunks("123456789"), { contentType: "text/plain" });
  const found = await store.get("k");
  if (found.status !== "found") throw new Error("not found");
  await store.put("k", chunks("1234"), { contentType: "text/plain" });

  await expect(drain(found.content)).rejects.toThrow(
    "BlobFs.Store: the blob under 'k' was replaced before its content was first read",
  );
});

it("fails the first pull, naming the key, when the blob was deleted", async () => {
  await store.put("k", chunks("123456789"), { contentType: "text/plain" });
  const found = await store.get("k");
  if (found.status !== "found") throw new Error("not found");
  await store.delete("k");

  await expect(drain(found.content)).rejects.toThrow(
    "BlobFs.Store: the blob under 'k' was deleted before its content was first read.",
  );
});

// Windows refuses to rename over a file that is open; the store's docs state the limit.
it.skipIf(process.platform === "win32")("delivers the rest of a blob whole when it is replaced after the first pull", async () => {
  const old = "o".repeat(200_000);
  await store.put("k", chunks(old), { contentType: "text/plain" });
  const found = await store.get("k");
  if (found.status !== "found") throw new Error("not found");
  const iterator = found.content[Symbol.asyncIterator]();
  const first = await iterator.next();
  await store.put("k", chunks("n".repeat(300_000)), { contentType: "image/png" });

  let text = new TextDecoder().decode(first.value);
  for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
    text += new TextDecoder().decode(next.value);
  }
  expect(text).toBe(old);
});

it("releases a blob's content that is returned before any pull", async () => {
  await store.put("k", chunks("123456789"), { contentType: "text/plain" });
  const found = await store.get("k");
  if (found.status !== "found") throw new Error("not found");

  const iterator = found.content[Symbol.asyncIterator]();
  await iterator.return?.();

  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

it("reports a key holding nothing as absent, and deletes idempotently", async () => {
  expect(await store.get("never")).toEqual({ status: "absent" });
  expect(await store.head("never")).toEqual({ status: "absent" });
  await store.delete("never");

  await store.put("k", chunks("x"), { contentType: "text/plain" });
  await store.delete("k");
  await store.delete("k");

  expect(await store.head("k")).toEqual({ status: "absent" });
  expect(await files(root)).toEqual([]);
});

it("refuses a file whose header names another key", async () => {
  const file = path.join(root, blobFile("wanted"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"v":1,"key":"other","contentType":"text/plain"}\ncontent');

  await expect(store.head("wanted")).rejects.toThrow(
    "holds the blob 'other', not the requested 'wanted'",
  );
  await expect(store.get("wanted")).rejects.toThrow(
    "holds the blob 'other', not the requested 'wanted'",
  );
});
