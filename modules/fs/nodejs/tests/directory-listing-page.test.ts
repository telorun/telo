import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) };
});

const fs = await import("node:fs/promises");
const { create } = await import("../src/directory-listing-controller.js");

let base: string;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), "telo-fs-listing-"));
  for (const dir of ["a", "b", "c"]) {
    await mkdir(path.join(base, dir));
    for (const file of ["1", "2", "3"]) await writeFile(path.join(base, dir, file), "");
  }
});

afterAll(() => rm(base, { recursive: true, force: true }));

beforeEach(() => {
  vi.mocked(fs.lstat).mockClear();
  vi.mocked(fs.readdir).mockClear();
});

const touched = (calls: unknown[][]) =>
  calls.map(([target]) => path.relative(base, String(target)).split(path.sep).join("/"));

it("reads a page and its one look-ahead, and nothing past it", async () => {
  const listing = await create({ kind: "Fs.DirectoryListing", metadata: { name: "listing" }, cwd: base });

  const page = await listing.invoke({ recursive: true, limit: 2, cursor: "b" });

  expect(page.entries.map((entry) => entry.path)).toEqual(["b/1", "b/2"]);
  expect(page.nextCursor).toBe("b/2");
  // `a` lies wholly before the cursor and `c` past the look-ahead: neither is
  // listed, and no entry of either is stat-ed.
  expect(touched(vi.mocked(fs.readdir).mock.calls)).toEqual(["", "b"]);
  expect(touched(vi.mocked(fs.lstat).mock.calls)).toEqual(["b/1", "b/2", "b/3"]);
});
