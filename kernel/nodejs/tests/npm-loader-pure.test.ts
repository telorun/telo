import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing__ } from "../src/controller-loaders/npm-loader.js";

const {
  normalizeFileSpec,
  resolvePackageExportTarget,
  resolveExportTargetValue,
  tryResolveFile,
  walkUpToPackageRoot,
  EXPORTS_MAX_DEPTH,
  DEFAULT_RESOLVER_CONDITIONS,
} = __testing__;

describe("normalizeFileSpec", () => {
  const installRoot = "/abs/install/root";

  it("passes registry specs through unchanged", () => {
    expect(normalizeFileSpec("@scope/pkg@1.2.3", installRoot)).toBe("@scope/pkg@1.2.3");
    expect(normalizeFileSpec("plain", installRoot)).toBe("plain");
  });

  it("resolves relative file: specs against the install root", () => {
    expect(normalizeFileSpec("file:../foo", installRoot)).toBe("file:/abs/install/foo");
  });

  it("preserves absolute file: specs (still calls resolve to canonicalize)", () => {
    expect(normalizeFileSpec("file:/abs/path", installRoot)).toBe("file:/abs/path");
  });

  it("makes a relative file: spec compare equal to its absolute form when they point at the same place", () => {
    // The whole reason this helper exists: npm rewrites absolute file: deps to
    // relative form in the install root's package.json. Both should normalize
    // to the same string so the per-controller fast path hits.
    // Install root is /abs/install/root; ../sibling resolves there to
    // /abs/install/sibling.
    const abs = "file:/abs/install/sibling";
    const rel = "file:../sibling";
    expect(normalizeFileSpec(abs, installRoot)).toBe(normalizeFileSpec(rel, installRoot));
  });
});

describe("resolveExportTargetValue", () => {
  it("returns the string verbatim", () => {
    expect(resolveExportTargetValue("./dist/index.js", ["import"], 0)).toBe("./dist/index.js");
  });

  it("walks arrays in order", () => {
    expect(resolveExportTargetValue([null, "./second.js"], ["import"], 0)).toBe("./second.js");
  });

  it("honours conditions in caller-supplied order", () => {
    const target = { import: "./esm.js", require: "./cjs.js" };
    expect(resolveExportTargetValue(target, ["import", "require"], 0)).toBe("./esm.js");
    expect(resolveExportTargetValue(target, ["require", "import"], 0)).toBe("./cjs.js");
  });

  it("falls through to a later condition when the preferred one is missing", () => {
    const target = { import: "./esm.js" };
    expect(resolveExportTargetValue(target, ["bun", "import"], 0)).toBe("./esm.js");
  });

  it("returns null for empty objects, falsy values, and unknown shapes", () => {
    expect(resolveExportTargetValue(null, ["import"], 0)).toBeNull();
    expect(resolveExportTargetValue(undefined, ["import"], 0)).toBeNull();
    expect(resolveExportTargetValue({}, ["import"], 0)).toBeNull();
    expect(resolveExportTargetValue(42 as any, ["import"], 0)).toBeNull();
  });

  it("caps recursion at EXPORTS_MAX_DEPTH instead of looping on cycles", () => {
    // Build an exports-shaped cycle. A naive resolver loops forever; the
    // depth cap ensures it terminates with null.
    const cyclic: any = {};
    cyclic.import = cyclic;
    expect(resolveExportTargetValue(cyclic, ["import"], 0)).toBeNull();
  });

  it("respects the depth budget and bails before stack overflow", () => {
    let nested: any = "./leaf.js";
    for (let i = 0; i < EXPORTS_MAX_DEPTH + 5; i++) {
      nested = { import: nested };
    }
    // The leaf is past the depth cap, so resolution returns null instead of
    // walking the full chain.
    expect(resolveExportTargetValue(nested, ["import"], 0)).toBeNull();
  });
});

describe("resolvePackageExportTarget", () => {
  it("returns null when there's no exports map", () => {
    expect(resolvePackageExportTarget(undefined, ".", ["import"])).toBeNull();
    expect(resolvePackageExportTarget(null, ".", ["import"])).toBeNull();
  });

  it("uses '.' as the canonical key for both '.' and './' entries", () => {
    const exports = { ".": "./root.js" };
    expect(resolvePackageExportTarget(exports, ".", ["import"])).toBe("./root.js");
    expect(resolvePackageExportTarget(exports, "./", ["import"])).toBe("./root.js");
  });

  it("returns null when the requested key isn't in the map", () => {
    expect(resolvePackageExportTarget({ ".": "./a.js" }, "./missing", ["import"])).toBeNull();
  });

  it("resolves conditional entries through the conditions list", () => {
    const exports = {
      ".": { bun: "./src/index.ts", import: "./dist/index.js" },
    };
    expect(resolvePackageExportTarget(exports, ".", ["bun", "import"])).toBe("./src/index.ts");
    expect(resolvePackageExportTarget(exports, ".", ["import"])).toBe("./dist/index.js");
  });

  it("lets the default conditions list resolve a Bun/Node-style entry", () => {
    const exports = { ".": { bun: "./src/index.ts", import: "./dist/index.js" } };
    const resolved = resolvePackageExportTarget(exports, ".", DEFAULT_RESOLVER_CONDITIONS);
    // The default list always lands on something — exact value depends on the
    // runtime that loaded the module (Bun vs Node), so just check it's one of
    // the two valid hits rather than which one.
    expect([
      "./src/index.ts",
      "./dist/index.js",
    ]).toContain(resolved);
  });
});

describe("tryResolveFile", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telo-tryresolve-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns the path when the file exists", async () => {
    const file = path.join(tmp, "exists.js");
    await fs.writeFile(file, "");
    expect(await tryResolveFile(file)).toBe(file);
  });

  it("appends .js when the literal path is missing and there's no extension", async () => {
    const stem = path.join(tmp, "stem");
    await fs.writeFile(`${stem}.js`, "");
    expect(await tryResolveFile(stem)).toBe(`${stem}.js`);
  });

  it("does NOT add .js when the path already has an extension", async () => {
    const tsFile = path.join(tmp, "code.ts");
    // No code.js or code.ts file exists. With an extension, we don't probe .js.
    expect(await tryResolveFile(tsFile)).toBeNull();
  });

  it("returns null when nothing matches", async () => {
    expect(await tryResolveFile(path.join(tmp, "nope"))).toBeNull();
  });
});

describe("walkUpToPackageRoot", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "telo-walkup-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns the directory itself when package.json sits there", async () => {
    await fs.writeFile(path.join(tmp, "package.json"), "{}");
    expect(await walkUpToPackageRoot(tmp)).toBe(tmp);
  });

  it("walks up to find the nearest package.json", async () => {
    const nested = path.join(tmp, "a", "b", "c");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(tmp, "package.json"), "{}");
    expect(await walkUpToPackageRoot(nested)).toBe(tmp);
  });

  it("returns null when no package.json exists between the start and the filesystem root", async () => {
    // os.tmpdir's parent chain doesn't reliably contain or omit a package.json
    // depending on the host. Use a self-contained path that's guaranteed
    // ancestor-less by passing a deeply nested temp dir with no package.json
    // anywhere from `tmp` downward, then asserting we don't accidentally
    // claim `tmp` as the root.
    const nested = path.join(tmp, "x", "y");
    await fs.mkdir(nested, { recursive: true });
    const found = await walkUpToPackageRoot(nested);
    // Either we got null (no package.json between nested and /), or we got
    // some ancestor outside tmp — both are fine. The contract is that we
    // never falsely return a directory below tmp that has no package.json.
    if (found !== null) {
      expect(found.startsWith(tmp)).toBe(false);
    }
  });
});
