import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { ModuleContext } from "../src/module-context.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A native function's `use: dependency` slot receives the referent's
 * configuration as its controller received it — a view, frozen, one per
 * declaration — and keeps it after Phase-5 injection, while its declaration
 * keeps the reference a reconcile rebuilds it through.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "__fixtures__/callable-data-views");

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function boot(
  fixture = FIXTURE,
): Promise<{ kernel: Kernel; appPath: string; read: (name: string) => any }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-callable-data-")));
  dirs.push(dir);
  await fs.cp(fixture, dir, { recursive: true });
  const appPath = path.join(dir, "telo.yaml");
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(appPath);
  await kernel.boot();
  const root = (kernel as unknown as { rootContext: any }).rootContext;
  return {
    kernel,
    appPath,
    read: (name) => root.resourceInstances.get(name).instance.call({}),
  };
}

function deeplyFrozen(value: unknown): boolean {
  if (!value || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
}

describe("a native function's data site", () => {
  it("holds the referent's configuration as its controller received it, frozen, one view per declaration", async () => {
    const { kernel, read } = await boot();
    const top = read("readTop");
    expect(top).toEqual({
      title: "T1.0.0",
      text: { text: "Top", context: "heading", lang: "en", computed: false },
      peer: {
        text: { text: "Hello", context: null, lang: "en", computed: false },
        pick: { root: "row", path: ["name"] },
      },
    });
    expect(deeplyFrozen(top)).toBe(true);
    expect(top.peer).toBe(read("readBase"));
    await kernel.teardown();
  });

  it("is rebuilt from the edited referent when a reconcile replaces it", async () => {
    const { kernel, appPath, read } = await boot();
    const text = await fs.readFile(appPath, "utf-8");
    await fs.writeFile(appPath, text.replace("text: Hello", "text: Howdy"));
    const outcome = await kernel.reconcile();
    expect([...outcome.reinitialized].sort()).toEqual(["base", "readBase", "readTop", "top"]);
    expect(read("readBase").text.text).toBe("Howdy");
    await kernel.teardown();
  });
});

describe("a native function in a template body", () => {
  it("is refused a sibling whose reference names a resource of the module defining the template", async () => {
    await expect(boot(path.resolve(here, "__fixtures__/callable-data-views-template"))).rejects.toThrow(
      "CallableDataViewsTemplateLib.Read/read: holds 'peer' at 'source' as data, but 'base' is a resource of the module defining the template",
    );
  });

  it("reads an optional need its module binds to nothing as a name of the module defining the template", () => {
    const module = new ModuleContext("test", {}, {}, {}, [], async () => null, async () => {});
    module.bindNeed("access", null);
    const body = module.spawnChildContext();
    expect([body.declaredBeyondReach("access"), body.declaredBeyondReach("nothing")]).toEqual([true, false]);
  });
});
