import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeTrailer } from "../src/package/app-trailer.js";
import { selfInvocation } from "../src/runner/self-invocation.js";

/** How the runner re-invokes this telo: an executable carrying an application
 *  is told to be the CLI, since every telo start strips `TELO_APP_CLI` and its
 *  children would otherwise be that application. */
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "telo-self-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("re-invoking this telo", () => {
  it("sets TELO_APP_CLI=1 for an executable carrying an application, and nothing otherwise", async () => {
    const payload = Buffer.from("an application");
    const packaged = path.join(dir, "orders");
    await fs.writeFile(packaged, Buffer.concat([Buffer.alloc(64, 1), payload, encodeTrailer(payload)]));
    const plain = path.join(dir, "telo");
    await fs.writeFile(plain, Buffer.alloc(4096, 2));

    expect(await selfInvocation({ singleFileExecutable: true, execPath: packaged, script: undefined })).toEqual({
      command: packaged,
      prefix: [],
      env: { TELO_APP_CLI: "1" },
    });
    expect(await selfInvocation({ singleFileExecutable: true, execPath: plain, script: undefined })).toEqual({
      command: plain,
      prefix: [],
      env: {},
    });
    // An npm install re-enters through its script; the Node runtime carries nothing.
    expect(
      await selfInvocation({ singleFileExecutable: false, execPath: process.execPath, script: "/bin/telo.mjs" }),
    ).toEqual({ command: process.execPath, prefix: ["/bin/telo.mjs"], env: {} });
  });
});
