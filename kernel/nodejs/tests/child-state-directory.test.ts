import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * A child application started by a resource gets a state directory of its own,
 * `<state dir>/apps/<path>`, instead of losing the parent's.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "child-state");
const PARENT = path.join(FIXTURES, "parent");

class Capture {
  readonly chunks: string[] = [];
  get stream(): NodeJS.WritableStream {
    return { write: (chunk: string) => void this.chunks.push(String(chunk)) } as never;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-child-state-"));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function run(stdout = new Capture(), stderr = new Capture(), entry = PARENT): Promise<Capture> {
  const kernel = new Kernel({
    sources: [new LocalFileSource()],
    env: { TELO_HOST_STATE_DIR: scratch },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  await kernel.load(entry);
  await kernel.start();
  return stdout;
}

describe("a child application's state directory", () => {
  it("is apps/<module path and name>, for a root instance and a library's alike", async () => {
    const out = await run();
    expect(out.text).toContain(`data=${path.join(scratch, "apps", "web", "needs", "data")}`);
    expect(out.text).toContain(`data=${path.join(scratch, "apps", "Admin.web", "needs", "data")}`);
    expect(fs.statSync(path.join(scratch, "apps", "web", "needs", "data")).isDirectory()).toBe(true);
  }, 60_000);
});

describe("a child application declared in a scope", () => {
  it("sits beneath its holder, and a second run warns of nothing", async () => {
    const entry = path.join(FIXTURES, "scoped-parent");
    const out = await run(new Capture(), new Capture(), entry);
    expect(out.text).toContain(`data=${path.join(scratch, "apps", "seq.web", "needs", "data")}`);
    const stderr = new Capture();
    await run(new Capture(), stderr, entry);
    expect(stderr.text).not.toContain("NEED_ORPHANED");
    expect(stderr.text).not.toContain("apps/");
  }, 60_000);
});

describe("a child application's own child", () => {
  it("nests beneath its parent's apps/", async () => {
    const out = await run(new Capture(), new Capture(), path.join(FIXTURES, "grandparent"));
    const nested = path.join(scratch, "apps", "mid", "apps", "web", "needs", "data");
    expect(out.text).toContain(`data=${nested}`);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
  }, 60_000);
});

describe("a stateless child application", () => {
  it("is neither refused nor warned about beside a stateful one, and its apps/ directory is created at load", async () => {
    const entry = path.join(FIXTURES, "mixed-parent");
    fs.mkdirSync(path.join(scratch, "apps", "web"), { recursive: true });
    const stderr = new Capture();
    await run(new Capture(), stderr, entry);
    expect(stderr.text).not.toContain("NEED_ORPHANED");
    expect(fs.statSync(path.join(scratch, "apps", "plain")).isDirectory()).toBe(true);
  }, 60_000);
});

describe("an entry under apps/ no application names", () => {
  it("refuses a load that would create a fresh directory beside it, naming both", async () => {
    fs.mkdirSync(path.join(scratch, "apps", "site"), { recursive: true });
    const error = await run().catch((e: Error & { code?: string }) => e);
    expect(error).toMatchObject({ code: "ERR_NEED_ORPHANED" });
    expect((error as Error).message).toContain("'apps/site'");
    expect((error as Error).message).toContain("'apps/web' for 'web'");
    expect((error as Error).message).toContain("move the old directory to the new path to keep its files, or delete it");
  }, 60_000);

  it("is only warned about when nothing fresh would be created", async () => {
    for (const name of ["web", "Admin.web", "site"]) fs.mkdirSync(path.join(scratch, "apps", name), { recursive: true });
    const stderr = new Capture();
    await run(new Capture(), stderr);
    expect(stderr.text).toContain("'apps/site'");
    expect(fs.existsSync(path.join(scratch, "apps", "site"))).toBe(true);
  }, 60_000);
});

describe("a child application's missing input", () => {
  it("is refused at the child's start naming the instance and the fix, and is never asked for", async () => {
    const asked: string[] = [];
    const stderr = new Capture();
    const kernel = new Kernel({
      sources: [new LocalFileSource()],
      env: {},
      stdout: new Capture().stream,
      stderr: stderr.stream,
    });
    await kernel.load(path.join(FIXTURES, "needy-parent"), {
      inputResolver: async (unresolved) => {
        asked.push(...unresolved.map((input) => input.id));
        return undefined;
      },
    });
    await kernel.start();
    expect(asked).toEqual([]);
    expect(stderr.text).toContain(
      "App.Instance/web: variable 'greeting' of ../needy has no value",
    );
    expect(stderr.text).toContain(
      "has no value: supply it under web's variables:, or declare it on Telo.Application/Wrapper and pass it through, which asks for it",
    );
  }, 60_000);
});
