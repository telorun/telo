import { InvokeError } from "@telorun/sdk";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fail = vi.hoisted(() => ({
  rename: undefined as string | undefined,
  link: undefined as string | undefined,
  rmdir: undefined as string | undefined,
}));

const injected = (code: string) => Object.assign(new Error("injected"), { code });

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (fail.rename) throw injected(fail.rename);
      return actual.rename(from, to);
    },
    link: async (from: string, to: string) => {
      if (fail.link) throw injected(fail.link);
      return actual.link(from, to);
    },
    rmdir: async (dir: string) => {
      if (fail.rmdir) throw injected(fail.rmdir);
      return actual.rmdir(dir);
    },
  };
});

const { copyAtomically } = await import("../src/path-copy-controller.js");
const { create } = await import("../src/path-move-controller.js");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "fs-transfer-"));
  fail.rename = fail.link = fail.rmdir = undefined;
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("Fs.Copy", () => {
  it("leaves no destination, temporary copy or made parent when a file fails part-way", async () => {
    const source = path.join(root, "src");
    await mkdir(path.join(source, "deep"), { recursive: true });
    await writeFile(path.join(source, "a.txt"), "a");
    await writeFile(path.join(source, "deep", "b.txt"), "b");
    await writeFile(path.join(source, "deep", "c.txt"), "c");

    let copied = 0;
    const failing = async (from: string, to: string, mode: number) => {
      if (++copied === 3) throw Object.assign(new Error("boom"), { code: "EIO" });
      await copyFile(from, to, mode);
    };

    await expect(
      copyAtomically(source, path.join(root, "made", "parents", "dest"), failing),
    ).rejects.toThrow(/Fs\.Copy: cannot copy.*EIO/);

    expect(copied).toBe(3);
    expect(await readdir(root)).toEqual(["src"]);
  });
});

describe("Fs.Move", () => {
  const mover = () =>
    create({ metadata: { name: "m", module: "m" }, cwd: root }, { log: { info() {} } } as never);

  it("maps a move across filesystems to ERR_MOVE_CROSS_DEVICE and leaves no made parents", async () => {
    await writeFile(path.join(root, "f.txt"), "x");
    const move = await mover();
    fail.link = "EXDEV";

    const err = await move.invoke({ path: "f.txt", destination: "made/dest.txt" }).catch((e) => e);

    expect(err).toBeInstanceOf(InvokeError);
    expect(err.code).toBe("ERR_MOVE_CROSS_DEVICE");
    expect((await readdir(root)).sort()).toEqual(["f.txt"]);
  });

  it("raises the original failure with the cleanup failure attached when cleanup fails too", async () => {
    await writeFile(path.join(root, "f.txt"), "x");
    const move = await mover();
    fail.link = "EXDEV";
    fail.rmdir = "EIO";

    const err = await move.invoke({ path: "f.txt", destination: "made/dest.txt" }).catch((e) => e);

    expect(err.code).toBe("ERR_MOVE_CROSS_DEVICE");
    expect(err.cleanupFailure.code).toBe("EIO");
    expect(err.message).toMatch(/cleanup also failed/);
  });

  it("refuses with ERR_PATH_EXISTS a file or directory that appears at the destination after the check", async () => {
    await writeFile(path.join(root, "f.txt"), "x");
    await mkdir(path.join(root, "d"));
    const move = await mover();

    fail.link = "EEXIST";
    const file = await move.invoke({ path: "f.txt", destination: "made/f.txt" }).catch((e) => e);
    fail.rename = "ENOTEMPTY";
    const dir = await move.invoke({ path: "d", destination: "made/d" }).catch((e) => e);

    expect(file.code).toBe("ERR_PATH_EXISTS");
    expect(dir.code).toBe("ERR_PATH_EXISTS");
    expect((await readdir(root)).sort()).toEqual(["d", "f.txt"]);
  });
});
