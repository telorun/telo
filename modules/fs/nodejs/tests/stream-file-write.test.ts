import {
  ERR_INPUT_INVALID,
  ERR_INVOKE_CANCELLED,
  InvokeError,
  type ResourceContext,
} from "@telorun/sdk";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const fs = await import("node:fs/promises");
const { create } = await import("../src/file-write-controller.js");

const ctx = {
  log: { enabled: () => false, warn: () => {}, debug: () => {} },
} as unknown as ResourceContext;

const bytes = (text: string) => new TextEncoder().encode(text);

/** A source of `chunks` that records how it was read. */
function source(chunks: Uint8Array[], failWith?: unknown) {
  const seen = { pulled: 0, released: false };
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (seen.pulled < chunks.length) return { done: false, value: chunks[seen.pulled++] };
          if (failWith !== undefined) throw failWith;
          return { done: true, value: undefined };
        },
        async return() {
          seen.released = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  return { iterable, seen };
}

let dir: string;
let write: Awaited<ReturnType<typeof create>>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "telo-fs-stream-write-"));
  write = await create({ metadata: { name: "write", module: "test" }, cwd: dir }, ctx);
});

afterEach(async () => {
  vi.mocked(fs.rename).mockClear();
  await rm(dir, { recursive: true, force: true });
});

it("stages a stream beside the target and renames it over the target once it ends", async () => {
  await writeFile(path.join(dir, "report.bin"), "old");
  const during: { entries: string[]; target: string }[] = [];
  async function* observed() {
    yield bytes("new ");
    during.push({
      entries: (await readdir(dir)).sort(),
      target: await readFile(path.join(dir, "report.bin"), "utf8"),
    });
    yield bytes("content");
  }

  const result = await write.invoke({ path: "report.bin", content: observed() });

  expect(result).toEqual({ bytesWritten: 11 });
  expect(during).toHaveLength(1);
  expect(during[0].target).toBe("old");
  expect(during[0].entries).toHaveLength(2);
  expect(during[0].entries[0]).toMatch(/^\.report\.bin\.[0-9a-f]{16}\.tmp$/);
  expect(await readdir(dir)).toEqual(["report.bin"]);
  expect(await readFile(path.join(dir, "report.bin"), "utf8")).toBe("new content");
});

// Windows reports no such mode.
it.skipIf(process.platform === "win32")("keeps the permission bits of the regular file a stream replaces", async () => {
  const target = path.join(dir, "locked.bin");
  await writeFile(target, "old");
  await chmod(target, 0o640);

  await write.invoke({ path: "locked.bin", content: source([bytes("new")]).iterable });

  expect((await stat(target)).mode & 0o7777).toBe(0o640);
  expect(await readFile(target, "utf8")).toBe("new");
});

it("writes a stream through a symbolic link, leaving the link in place", async () => {
  await writeFile(path.join(dir, "real.bin"), "old");
  await symlink("real.bin", path.join(dir, "link.bin"));

  await write.invoke({ path: "link.bin", content: source([bytes("new")]).iterable });

  expect((await lstat(path.join(dir, "link.bin"))).isSymbolicLink()).toBe(true);
  expect(await readlink(path.join(dir, "link.bin"))).toBe("real.bin");
  expect(await readFile(path.join(dir, "real.bin"), "utf8")).toBe("new");
  expect((await readdir(dir)).sort()).toEqual(["link.bin", "real.bin"]);
});

it.skipIf(process.platform === "win32")(
  "writes a stream aimed at a FIFO in place, staging nothing",
  async () => {
    const fifo = path.join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    const received = new Promise<string>((resolve, reject) => {
      let text = "";
      createReadStream(fifo, "utf8")
        .on("data", (chunk) => (text += chunk))
        .on("end", () => resolve(text))
        .on("error", reject);
    });

    const result = await write.invoke({
      path: "pipe",
      content: source([bytes("through "), bytes("the pipe")]).iterable,
    });

    expect(result).toEqual({ bytesWritten: 16 });
    expect(await received).toBe("through the pipe");
    expect((await lstat(fifo)).isFIFO()).toBe(true);
    expect(await readdir(dir)).toEqual(["pipe"]);
    expect(vi.mocked(fs.rename)).not.toHaveBeenCalled();
  },
);

it("refuses a stream over maxBytes, pulling one chunk past the bound and leaving the target as it was", async () => {
  await writeFile(path.join(dir, "kept.bin"), "previous");
  const chunk = new Uint8Array(10);
  const over = source([chunk, chunk, chunk, chunk, chunk, chunk]);

  const refused = write.invoke({ path: "kept.bin", content: over.iterable, maxBytes: 25n });

  await expect(refused).rejects.toMatchObject({
    code: "ERR_FILE_TOO_LARGE",
    data: { path: path.join(dir, "kept.bin"), maxBytes: 25 },
  });
  await expect(refused).rejects.not.toHaveProperty("data.size");
  expect(over.seen).toEqual({ pulled: 3, released: true });
  expect(await readdir(dir)).toEqual(["kept.bin"]);
  expect(await readFile(path.join(dir, "kept.bin"), "utf8")).toBe("previous");

  await expect(
    write.invoke({ path: "absent.bin", content: source([chunk, chunk]).iterable, maxBytes: 19 }),
  ).rejects.toMatchObject({ code: "ERR_FILE_TOO_LARGE" });
  expect(await readdir(dir)).toEqual(["kept.bin"]);
});

it("writes a stream of exactly maxBytes", async () => {
  const chunk = new Uint8Array(10);

  const result = await write.invoke({
    path: "exact.bin",
    content: source([chunk, chunk]).iterable,
    maxBytes: 20,
  });

  expect(result).toEqual({ bytesWritten: 20 });
});

it("refuses text and bytes over maxBytes with their size, before the file is opened", async () => {
  await writeFile(path.join(dir, "kept.txt"), "previous");

  await expect(
    write.invoke({ path: "kept.txt", content: "żółw", maxBytes: 6 }),
  ).rejects.toMatchObject({
    code: "ERR_FILE_TOO_LARGE",
    data: { path: path.join(dir, "kept.txt"), maxBytes: 6, size: 7 },
  });
  await expect(
    write.invoke({ path: "absent.bin", content: new Uint8Array(5), maxBytes: 4 }),
  ).rejects.toMatchObject({
    code: "ERR_FILE_TOO_LARGE",
    data: { path: path.join(dir, "absent.bin"), maxBytes: 4, size: 5 },
  });
  expect(await readdir(dir)).toEqual(["kept.txt"]);
  expect(await readFile(path.join(dir, "kept.txt"), "utf8")).toBe("previous");
});

it("rethrows a source failure as it was raised and removes the staging file", async () => {
  await writeFile(path.join(dir, "kept.bin"), "previous");
  const cancelled = new InvokeError(ERR_INVOKE_CANCELLED, "request-body-too-large");

  const failed = write.invoke({
    path: "kept.bin",
    content: source([bytes("partial")], cancelled).iterable,
  });

  await expect(failed).rejects.toBe(cancelled);
  expect(await readdir(dir)).toEqual(["kept.bin"]);
  expect(await readFile(path.join(dir, "kept.bin"), "utf8")).toBe("previous");
});

it("refuses a stream that yields a string with ERR_INPUT_INVALID and removes the staging file", async () => {
  const mixed = source([bytes("ok"), "text" as unknown as Uint8Array]);

  await expect(write.invoke({ path: "new.bin", content: mixed.iterable })).rejects.toMatchObject({
    code: ERR_INPUT_INVALID,
    data: { issues: [{ path: "content" }] },
  });
  expect(mixed.seen.released).toBe(true);
  expect(await readdir(dir)).toEqual([]);
});

it("reports a failed rename as a write error, with the target untouched and nothing staged", async () => {
  await writeFile(path.join(dir, "kept.bin"), "previous");
  vi.mocked(fs.rename).mockRejectedValueOnce(
    Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" }),
  );

  await expect(
    write.invoke({ path: "kept.bin", content: source([bytes("new")]).iterable }),
  ).rejects.toThrow(
    `Fs.FileWrite: cannot write '${path.join(dir, "kept.bin")}': cross-device link not permitted (EXDEV)`,
  );
  expect(await readdir(dir)).toEqual(["kept.bin"]);
  expect(await readFile(path.join(dir, "kept.bin"), "utf8")).toBe("previous");
});

/** A source that counts every pull and every release. */
function counted(chunks: Uint8Array[]) {
  const seen = { pulls: 0, releases: 0 };
  const iterable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        if (seen.pulls < chunks.length) return { done: false, value: chunks[seen.pulls++] };
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

async function releasedOnceUnpulled(target: { path: string; createParents?: boolean }) {
  const unread = counted([bytes("never read")]);

  await expect(write.invoke({ ...target, content: unread.iterable })).rejects.toThrow(
    "Fs.FileWrite: cannot write",
  );
  expect(unread.seen).toEqual({ pulls: 0, releases: 1 });
}

// Neither Windows nor the superuser is held to a directory's mode.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "releases a stream exactly once, unpulled, when its directory cannot be written",
  async () => {
    await fs.mkdir(path.join(dir, "sealed"));
    await chmod(path.join(dir, "sealed"), 0o500);

    await releasedOnceUnpulled({ path: "sealed/out.bin" });
  },
);

it.each([
  [
    "its parents cannot be created",
    async () => {
      await writeFile(path.join(dir, "file"), "in the way");
      return { path: "file/sub/out.bin", createParents: true };
    },
  ],
  [
    "it names a loop of links",
    async () => {
      await symlink("b", path.join(dir, "a"));
      await symlink("a", path.join(dir, "b"));
      return { path: "a" };
    },
  ],
])("releases a stream exactly once, unpulled, when %s", async (name, arrange) => {
  await releasedOnceUnpulled(await arrange());
});

it("does not release a stream that ended", async () => {
  const whole = counted([bytes("all of it")]);

  await write.invoke({ path: "out.bin", content: whole.iterable });

  expect(whole.seen).toEqual({ pulls: 2, releases: 0 });
});
