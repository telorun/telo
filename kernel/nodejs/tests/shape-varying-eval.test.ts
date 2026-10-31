import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A named shape a variable decides is read through the configuration the
 * process runs in: an eval site at load in one, an accessor field in the other,
 * on a cold boot and on warm ones (the analysis stamp hits).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "__fixtures__/shape-varying-eval/telo.yaml");

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-shape-varying-")));
});

afterEach(async () => {
  await fs.rm(cacheDir, { recursive: true, force: true });
});

async function boot(mode: string): Promise<unknown> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: { MODE: mode } });
  await kernel.load(app, { cacheDir });
  await kernel.boot();
  const rootContext = (kernel as unknown as { rootContext: any }).rootContext;
  const at = await rootContext.resourceInstances.get("probe").instance.provide();
  await kernel.teardown();
  return at;
}

describe("a named shape a variable decides", () => {
  it("hands each configuration's controller its own field kind, on a cold boot and on a warm one", async () => {
    expect(await boot("evaluated")).toEqual("hello");
    // The analysis stamp the first boot wrote is hit from here on.
    expect(await fs.readdir(path.join(cacheDir, "analysis"))).toHaveLength(1);
    expect(await boot("named")).toEqual({ value: "hello" });
    expect(await boot("evaluated")).toEqual("hello");
  });
});
