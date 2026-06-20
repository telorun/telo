import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectFiles } from "../src/bundle/select-files.js";
import { makeTarGz, readTarGz } from "../src/bundle/tar.js";

let workdir: string;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-bundle-test-"));
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

function write(rel: string, content = "x"): void {
  const abs = path.join(workdir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("selectFiles", () => {
  it("returns [] for no patterns", () => {
    expect(selectFiles(workdir, [])).toEqual([]);
  });

  it("selects files matching a positive glob, sorted and relative", () => {
    write("public/index.html");
    write("public/app.js");
    write("public/nested/style.css");
    write("telo.yaml");
    expect(selectFiles(workdir, ["public/**"])).toEqual([
      "public/app.js",
      "public/index.html",
      "public/nested/style.css",
    ]);
  });

  it("carves out files with a trailing `!` negation (last-match-wins)", () => {
    write("public/app.js");
    write("public/app.js.map");
    write("public/index.html");
    expect(selectFiles(workdir, ["public/**", "!**/*.map"])).toEqual([
      "public/app.js",
      "public/index.html",
    ]);
  });

  it("re-includes when a later positive pattern overrides a negation", () => {
    write("public/app.js.map");
    expect(selectFiles(workdir, ["public/**", "!**/*.map", "public/app.js.map"])).toEqual([
      "public/app.js.map",
    ]);
  });

  it("never ships the default-ignore set even when a pattern selects it", () => {
    write("node_modules/dep/index.js");
    write(".git/config");
    write(".telo/manifests/x/telo.yaml");
    write("public/app.js");
    expect(selectFiles(workdir, ["**"])).toEqual(["public/app.js"]);
  });

  it("can opt out of the default-ignore set (include: resolution)", () => {
    write("node_modules/dep/index.js");
    write("partials/a.yaml");
    const selected = selectFiles(workdir, ["**/*.yaml"], { applyDefaultIgnore: false });
    expect(selected).toContain("partials/a.yaml");
  });

  it("does not leak a symlink pointing outside the module directory", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telo-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "s");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workdir, "leak.txt"));
    } catch {
      return; // platform without symlink permission — skip
    }
    // A symlink is not a regular file, so it is skipped during enumeration —
    // it never enters the bundle. (The realpath confinement check is a
    // belt-and-suspenders guard for any path that does get enumerated.)
    expect(selectFiles(workdir, ["leak.txt"])).toEqual([]);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});

describe("makeTarGz / readTarGz", () => {
  it("round-trips text and binary entries", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const gz = await makeTarGz([
      { name: "telo.yaml", content: "kind: Telo.Application\n" },
      { name: "public/logo.png", content: png },
    ]);
    expect(gz.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // gzip magic

    const entries = await readTarGz(gz);
    const byName = new Map(entries.map((e) => [e.name, e.content as Buffer]));
    expect(byName.get("telo.yaml")?.toString("utf-8")).toBe("kind: Telo.Application\n");
    expect(byName.get("public/logo.png")).toEqual(png);
  });
});
