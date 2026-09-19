import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRealmShims, realmRequire } from "../src/controller-loaders/realm.js";
import { isWritableShimSlot, SHIM_MARKER } from "../src/controller-loaders/shim-package.js";

/**
 * How a controller bundle finds the SDK when there is no SDK on disk to point
 * at, and what the mechanism does when it cannot hold that guarantee.
 */
const made: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-realm-"));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("realm shims", () => {
  it("writes a package that re-exports the running kernel's SDK", async () => {
    const dir = await tempDir();
    await ensureRealmShims(dir, dir);

    const slot = path.join(dir, "node_modules", "@telorun", "sdk");
    const manifest = JSON.parse(await fs.readFile(path.join(slot, "package.json"), "utf8"));
    expect(manifest.name).toBe("@telorun/sdk");
    expect(manifest[SHIM_MARKER]).toBe("realm-shim");

    const source = await fs.readFile(path.join(slot, "index.mjs"), "utf8");
    // The instance comes out of the process, which is what makes it the
    // kernel's own however the kernel itself was delivered.
    expect(source).toContain('globalThis[Symbol.for("telo.realm")]');
    expect(source).toContain("export { v0 as");
    // A stray bundle with no kernel gets a sentence, not an empty module.
    expect(source).toContain("no Telo kernel is running in this process");
  });

  it("replaces a symlink an older kernel left, instead of writing through it", async () => {
    const dir = await tempDir();
    const victim = await tempDir();
    // Stand in for the SDK's own source tree: writing through the link would
    // replace this file.
    await fs.writeFile(path.join(victim, "package.json"), '{"name":"@telorun/sdk"}\n');

    const slot = path.join(dir, "node_modules", "@telorun", "sdk");
    await fs.mkdir(path.dirname(slot), { recursive: true });
    await fs.symlink(victim, slot, "dir");

    await ensureRealmShims(dir, dir);

    expect((await fs.lstat(slot)).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(victim, "package.json"), "utf8")).toBe(
      '{"name":"@telorun/sdk"}\n',
    );
  });

  it("leaves a package an installer owns, and says so", async () => {
    const dir = await tempDir();
    const slot = path.join(dir, "node_modules", "@telorun", "sdk");
    await fs.mkdir(slot, { recursive: true });
    await fs.writeFile(path.join(slot, "package.json"), '{"name":"@telorun/sdk"}\n');

    // Outside any cache root, the slot rule reads the package.json through
    // whatever is there and refuses a slot with no marker.
    expect(await isWritableShimSlot(slot, undefined)).toBe(false);

    const said: string[] = [];
    await ensureRealmShims(dir, undefined, {
      debug: (message: string) => said.push(message),
    } as never);
    expect(said.join("\n")).toContain("realm slot");
    expect(await fs.readFile(path.join(slot, "package.json"), "utf8")).toBe(
      '{"name":"@telorun/sdk"}\n',
    );
  });

  it("serves ajv's runtime helpers in-process, by either spelling", () => {
    const withExtension = realmRequire("ajv/dist/runtime/ucs2length.js") as { default?: unknown };
    // A compiled validator names them without the extension.
    expect(realmRequire("ajv/dist/runtime/ucs2length")).toBe(withExtension);
    expect(typeof withExtension.default).toBe("function");
    expect(realmRequire("nothing/the/realm/carries")).toBeUndefined();
  });
});
