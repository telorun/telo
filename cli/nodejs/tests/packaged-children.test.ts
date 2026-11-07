import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeTrailer } from "../src/package/app-trailer.js";
import { buildAppPayload } from "../src/package/build-app-payload.js";

/**
 * An application started by a resource whose kind declares
 * `x-telo-application-source` travels with its parent: manifest, import closure
 * and built local modules, so the packaged binary starts the child from the
 * unpacked tree.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = path.join(ROOT, "cli/nodejs/bin/telo.ts");
const FIXTURE = path.join(ROOT, "cli/nodejs/tests/__fixtures__/packaged-children/parent");
const VIA_CMD = process.platform === "win32";
const quote = (arg: string) => (VIA_CMD ? `"${arg}"` : arg);

let dir: string;
let executable: string;
let modules: { source: string; name?: string; delivery: string }[];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-packaged-children-"));
  const { payload, index } = await buildAppPayload({
    manifestPath: FIXTURE,
    platform: { os: "linux", arch: "amd64", libc: "gnu", abi: "node-137" },
    report: () => {},
  });
  modules = index.modules as typeof modules;
  executable = path.join(dir, "supervisor");
  fs.writeFileSync(executable, Buffer.concat([Buffer.alloc(64, 1), payload, encodeTrailer(payload)]));
}, 120_000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("a packaged supervisor", () => {
  it("lists the child application and its imports among the payload's modules", () => {
    const named = modules.map((module) => module.name);
    expect(named).toEqual(expect.arrayContaining(["Supervisor", "Greeter", "App", "Console"]));
    expect(modules.find((module) => module.name === "Greeter")?.delivery).toBe("local");
  });

  // The parent reads the child's line through its channel and asserts it, so a
  // run that exits 0 heard it; stdout alone could exit before a pipe flushed.
  it("starts the child from the unpacked tree", () => {
    const env = { ...process.env, TELO_APP_DIR: path.join(dir, "apps-root") };
    delete env.TELO_CACHE_DIR;
    delete env.TELO_APP_CLI;
    expect(() =>
      execFileSync("bun", [CLI, "run", executable].map(quote), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: VIA_CMD,
        env,
      }),
    ).not.toThrow();
  }, 120_000);
});
