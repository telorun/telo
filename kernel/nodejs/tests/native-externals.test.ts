import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildControllerFromSource } from "../src/controller-loaders/source-bundle-builder.js";

/**
 * A controller may depend on a package whose whole content is a native addon.
 * esbuild has no loader for a `.node` file, so the build used to fail on the
 * file rather than on the import that reached it — which reads as a defect in
 * the bundler rather than as what it is.
 */
const made: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-native-ext-"));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of made.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A module whose controller imports a package that is one addon, the shape
 *  `@napi-rs/canvas`'s per-platform packages take. */
async function moduleImportingAnAddon(): Promise<{ entry: string; cacheRoot: string }> {
  const root = await tempDir();
  const addon = path.join(root, "node_modules", "fake-addon");
  await fs.mkdir(addon, { recursive: true });
  await fs.writeFile(
    path.join(addon, "package.json"),
    JSON.stringify({ name: "fake-addon", main: "addon.node" }),
  );
  // Contents are never read: the point is that it cannot be inlined.
  await fs.writeFile(path.join(addon, "addon.node"), "\0not javascript");

  const src = path.join(root, "src");
  await fs.mkdir(src, { recursive: true });
  const entry = path.join(src, "index.ts");
  await fs.writeFile(
    entry,
    'import addon from "fake-addon";\nexport const probe = { addon };\n',
  );
  return { entry, cacheRoot: await tempDir() };
}

describe("native externals", () => {
  it("bundles a controller that depends on a native package, and says what it left out", async () => {
    const { entry, cacheRoot } = await moduleImportingAnAddon();
    const said: Array<Record<string, unknown> | undefined> = [];
    const bundle = await buildControllerFromSource(entry, cacheRoot, [], undefined, {
      info: (_message: string, attributes?: Record<string, unknown>) => said.push(attributes),
    } as never);

    const text = await fs.readFile(bundle, "utf8");
    // Left for the runtime to resolve rather than inlined — the build no longer
    // fails on a file it has no loader for.
    expect(text).toContain('from "fake-addon"');

    // Named at the build that decided it — the alternative is learning about it
    // from a module-not-found in production.
    const reported = said.find((attributes) => attributes?.["telo.bundle.external"] === "fake-addon");
    expect(reported).toBeDefined();
    expect(String(reported?.["telo.bundle.remedy"])).toContain("resolveNativeFile");
  });
});
