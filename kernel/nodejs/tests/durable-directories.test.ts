import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withoutHostValues } from "../src/host-values.js";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import type { ModuleContext } from "../src/module-context.js";

class Capture {
  readonly chunks: string[] = [];
  get stream(): NodeJS.WritableStream {
    return { write: (chunk: string) => void this.chunks.push(String(chunk)) } as never;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

const app = (needs: string, extra = "") => `kind: Telo.Application
metadata:
  name: Shop
needs:
${needs}${extra}`;

const UPLOADS = `  uploads:
    kind: Telo.DurableDirectory
`;

let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "telo-durable-"));
});
afterEach(() => {
  fs.chmodSync(scratch, 0o700);
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function load(
  manifests: Record<string, string>,
  env: Record<string, string>,
  stderr = new Capture(),
): Promise<Kernel> {
  const memory = new MemorySource();
  for (const [name, text] of Object.entries(manifests)) memory.set(name, text);
  const kernel = new Kernel({ sources: [memory], env, stderr: stderr.stream });
  await kernel.load("memory://app");
  return kernel;
}

async function failure(
  manifests: Record<string, string>,
  env: Record<string, string>,
): Promise<Error & { code?: string }> {
  try {
    const kernel = await load(manifests, env);
    await kernel.boot();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error("expected the load to fail");
}

/** The fields a root need is bound to. */
function rootNeed(kernel: Kernel, name: string): Record<string, unknown> {
  const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
  const bound = (root as unknown as {
    resourceInstances: Map<string, { instance: { fields: Record<string, unknown> } }>;
  }).resourceInstances.get(name);
  return bound!.instance.fields;
}

describe("a durable directory answered from TELO_HOST_STATE_DIR", () => {
  it("is <state dir>/needs/<need path>, created at load", async () => {
    const kernel = await load({ app: app(UPLOADS) }, { TELO_HOST_STATE_DIR: scratch });
    const directory = path.join(scratch, "needs", "uploads");
    expect(rootNeed(kernel, "uploads")).toEqual({ path: directory });
    expect(fs.statSync(directory).isDirectory()).toBe(true);
  });

  it("gives a library's need its need path, joined by '.'", async () => {
    const library = `kind: Telo.Library
metadata:
  name: Files
needs:
  uploads:
    kind: Telo.DurableDirectory
`;
    const kernel = await load(
      { app: `kind: Telo.Application\nmetadata:\n  name: Shop\nimports:\n  Files: memory://files\n`, files: library },
      { TELO_HOST_STATE_DIR: scratch },
    );
    await kernel.boot();
    expect(fs.statSync(path.join(scratch, "needs", "Files.uploads")).isDirectory()).toBe(true);
    await kernel.teardown();
  });

  it("reads the need's own env name before the state directory", async () => {
    const own = path.join(scratch, "own");
    const kernel = await load(
      { app: app(UPLOADS) },
      { TELO_HOST_STATE_DIR: path.join(scratch, "state"), TELO_NEED_UPLOADS__PATH: own },
    );
    expect(rootNeed(kernel, "uploads")).toEqual({ path: own });
    expect(fs.existsSync(path.join(scratch, "state", "needs"))).toBe(false);
  });

  it("is unmet with neither set, naming the env name", async () => {
    const error = await failure({ app: app(UPLOADS) }, {});
    expect(error.code).toBe("ERR_NEED_UNMET");
    expect(error.message).toContain("TELO_NEED_UPLOADS__PATH");
  });

  it("is hidden from every controller", async () => {
    const kernel = await load({ app: app(UPLOADS) }, { TELO_HOST_STATE_DIR: scratch, OTHER: "kept" });
    const root = (kernel as unknown as { rootContext: ModuleContext }).rootContext;
    const ctx = (kernel as unknown as {
      createResourceContext(m: ModuleContext, r: unknown): { env: Record<string, string | undefined> };
    }).createResourceContext(root, { kind: "Test.Probe", metadata: { name: "probe" } });
    expect([ctx.env.TELO_HOST_STATE_DIR, ctx.env.OTHER]).toEqual([undefined, "kept"]);
  });
});

describe("an entry under the state directory no need names", () => {
  it("refuses a load that would create a fresh directory beside it, naming both", async () => {
    fs.mkdirSync(path.join(scratch, "needs", "uploads"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "needs", "uploads", "kept.txt"), "x");
    const renamed = `  files:
    kind: Telo.DurableDirectory
`;
    const error = await failure({ app: app(renamed) }, { TELO_HOST_STATE_DIR: scratch });
    expect(error.code).toBe("ERR_NEED_ORPHANED");
    expect(error.message).toContain("'needs/uploads'");
    expect(error.message).toContain("'needs/files' for need 'files'");
    expect(fs.existsSync(path.join(scratch, "needs", "files"))).toBe(false);

    // Moving the directory to the new path keeps its files.
    fs.renameSync(path.join(scratch, "needs", "uploads"), path.join(scratch, "needs", "files"));
    const kernel = await load({ app: app(renamed) }, { TELO_HOST_STATE_DIR: scratch });
    expect(fs.readFileSync(path.join(rootNeed(kernel, "files").path as string, "kept.txt"), "utf8")).toBe("x");
  });

  it("is only warned about when nothing fresh would be created", async () => {
    fs.mkdirSync(path.join(scratch, "needs", "uploads"), { recursive: true });
    fs.mkdirSync(path.join(scratch, "needs", "old"), { recursive: true });
    const stderr = new Capture();
    await load({ app: app(UPLOADS) }, { TELO_HOST_STATE_DIR: scratch }, stderr);
    expect(stderr.text).toContain("'needs/old'");
    expect(fs.existsSync(path.join(scratch, "needs", "old"))).toBe(true);
  });
});

describe("a durable directory that is not usable", () => {
  it("is refused at load when its env name names a regular file", async () => {
    const file = path.join(scratch, "file");
    fs.writeFileSync(file, "");
    const error = await failure({ app: app(UPLOADS) }, { TELO_NEED_UPLOADS__PATH: file });
    expect(error.code).toBe("ERR_NEED_DIRECTORY_UNUSABLE");
    expect(error.message).toContain("need 'uploads'");
    expect(error.message).toContain("TELO_NEED_UPLOADS__PATH");
    expect(error.message).toContain("it is not a directory");
  });

  // Mode bits do not restrict a directory on Windows, and root writes through them.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("is refused when the process cannot write to it", async () => {
    const readOnly = path.join(scratch, "read-only");
    fs.mkdirSync(readOnly);
    fs.chmodSync(readOnly, 0o500);
    const error = await failure({ app: app(UPLOADS) }, { TELO_NEED_UPLOADS__PATH: readOnly });
    expect(error.code).toBe("ERR_NEED_DIRECTORY_UNUSABLE");
    expect(error.message).toContain("the process cannot write to it");
    fs.chmodSync(readOnly, 0o700);
  });

  it("is refused when supplied field by field at an import, naming the import", async () => {
    const file = path.join(scratch, "file");
    fs.writeFileSync(file, "");
    const library = `kind: Telo.Library
metadata:
  name: Files
needs:
  uploads:
    kind: Telo.DurableDirectory
`;
    const root = `kind: Telo.Application
metadata:
  name: Shop
imports:
  Files:
    source: memory://files
    needs:
      uploads: { path: ${JSON.stringify(file)} }
`;
    const error = await failure({ app: root, files: library }, {});
    expect(JSON.stringify(error)).toContain("ERR_NEED_DIRECTORY_UNUSABLE");
    expect(error.message + JSON.stringify(error)).toContain("import 'Files'");
  });
});

describe("a started child application", () => {
  it("inherits no state directory, and keeps the container-engine values", () => {
    expect(
      withoutHostValues({
        TELO_HOST_STATE_DIR: "/state",
        TELO_HOST_CONTAINER_ENGINE_URL: "unix:///var/run/docker.sock",
        PATH: "/bin",
      }),
    ).toEqual({ TELO_HOST_CONTAINER_ENGINE_URL: "unix:///var/run/docker.sock", PATH: "/bin" });
  });
});
