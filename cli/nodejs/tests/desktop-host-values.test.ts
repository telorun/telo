import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDesktopHostValues } from "../src/desktop/desktop-host-values.js";

describe("what the desktop host gives the kernel", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telo-desktop-values-")));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const seedFile = () => path.join(dir, "desktop-host", "secret-seed");

  it("keeps one seed across starts, at 0600, and sets the per-user state directory", () => {
    const first: NodeJS.ProcessEnv = {};
    applyDesktopHostValues(dir, first);
    expect(first.TELO_HOST_STATE_DIR).toBe(path.join(dir, "state"));
    expect(first.TELO_HOST_SECRET_SEED).toHaveLength(43);
    if (process.platform !== "win32") expect(fs.statSync(seedFile()).mode & 0o777).toBe(0o600);
    const second: NodeJS.ProcessEnv = {};
    applyDesktopHostValues(dir, second);
    expect(second.TELO_HOST_SECRET_SEED).toBe(first.TELO_HOST_SECRET_SEED);
  });

  it("reads nothing where the environment names a seed, and writes no file", () => {
    const env: NodeJS.ProcessEnv = { TELO_HOST_SECRET_SEED: "named", TELO_HOST_STATE_DIR: "/named" };
    applyDesktopHostValues(dir, env);
    expect(env).toEqual({ TELO_HOST_SECRET_SEED: "named", TELO_HOST_STATE_DIR: "/named" });
    expect(fs.existsSync(seedFile())).toBe(false);
  });

  it("refuses a malformed file naming it, never its contents, and leaves it untouched", () => {
    fs.mkdirSync(path.dirname(seedFile()), { recursive: true });
    fs.writeFileSync(seedFile(), "shortseed\n");
    let error: (Error & { code?: string }) | undefined;
    try {
      applyDesktopHostValues(dir, {});
    } catch (e) {
      error = e as Error;
    }
    expect(error?.code).toBe("ERR_NEED_HOST_VALUE_INVALID");
    expect(error?.message).toBe(`${seedFile()} does not hold 32 bytes of unpadded base64url`);
    expect(fs.readFileSync(seedFile(), "utf8")).toBe("shortseed\n");
  });
});
