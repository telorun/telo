import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A `Telo.Import` declared in a scope is a module instance beneath its holders:
 * its needs are named `<holder>.<member>.<need>`, read from the environment at
 * load like any need reaching the root, and bound when the scope opens.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, "__fixtures__/scoped-import-needs/telo.yaml");

const kernels: Kernel[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.teardown();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-scoped-needs-")));
  dirs.push(dir);
  return dir;
}

describe("a scoped import's needs", () => {
  it("binds each holder's instance to the directory its own name supplies", async () => {
    const first = await scratch();
    const second = await scratch();
    const kernel = new Kernel({
      sources: [new LocalFileSource()],
      env: {
        TELO_NEED_FIRST__INNER__STORAGE__PATH: first,
        TELO_NEED_SECOND__INNER__STORAGE__PATH: second,
      },
    });
    kernels.push(kernel);
    await kernel.load(ENTRY);
    await kernel.boot();
    const report = (name: string) =>
      kernel.invoke<unknown, { path: string }>({ kind: "Telo.Sequence", name }, {});
    expect((await report("first")).path).toBe(first);
    expect((await report("second")).path).toBe(second);
  }, 60_000);

  it("refuses the load when nothing supplies one, naming its variable", async () => {
    const kernel = new Kernel({
      sources: [new LocalFileSource()],
      env: { TELO_NEED_SECOND__INNER__STORAGE__PATH: await scratch() },
    });
    kernels.push(kernel);
    const failure = await kernel.load(ENTRY).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      code: "ERR_NEED_UNMET",
      message: expect.stringContaining("Set TELO_NEED_FIRST__INNER__STORAGE__PATH"),
    });
  }, 60_000);
});
